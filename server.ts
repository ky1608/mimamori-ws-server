import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";

const app = Fastify({ logger: true });
app.register(fastifyWebsocket);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// mulaw → pcm16 変換
function mulawToLinear(mulawByte: number): number {
  mulawByte = ~mulawByte & 0xff;
  const sign = mulawByte & 0x80;
  const exponent = (mulawByte >> 4) & 0x07;
  const mantissa = mulawByte & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign !== 0 ? -sample : sample;
}

// pcm16 → mulaw 変換
function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function mulawBufferToPcm16Buffer(mulawBuf: Buffer): Buffer {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    const sample = mulawToLinear(mulawBuf[i]);
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

function pcm16BufferToMulawBuffer(pcmBuf: Buffer): Buffer {
  // 奇数バイトの場合は切り捨て
  const samples = Math.floor(pcmBuf.length / 2);
  const mulaw = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    const sample = pcmBuf.readInt16LE(i * 2);
    mulaw[i] = linearToMulaw(sample);
  }
  return mulaw;
}

// Twilio Media Stream → Grok Voice API ブリッジ
app.register(async (fastify) => {
  fastify.get("/stream", { websocket: true }, (twilioWs, req) => {
    const url = new URL(`ws://localhost${req.url}`);
    const userId       = url.searchParams.get("userId")       ?? "";
    const systemPrompt = decodeURIComponent(url.searchParams.get("systemPrompt") ?? "");

    let callSid   = "";
    let rawLog    = "";
    let grokWs: WebSocket | null = null;
    let streamSid = "";

    console.log(`[ws] 接続開始 userId=${userId}`);

    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      console.error("[ws] XAI_API_KEY が設定されていません");
      twilioWs.close();
      return;
    }
    console.log(`[ws] XAI_API_KEY 確認済み（先頭8文字: ${apiKey.slice(0, 8)}...）`);

    // モデルをURLに指定してGrok Voice APIに接続
    grokWs = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-2-voice-preview", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    grokWs.on("open", () => {
      console.log("[ws] Grok Voice API 接続完了");

      // セッション設定
      grokWs!.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: systemPrompt,
          voice: "Eve",
          turn_detection: {
            type: "server_vad",
          },
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
        },
      }));
      console.log("[ws] session.update 送信完了");

      // Grokに最初の発話を促す
      grokWs!.send(JSON.stringify({ type: "response.create" }));
      console.log("[ws] response.create 送信完了");
    });

    // Grok → Twilio（音声・テキスト）
    grokWs.on("message", (data: Buffer) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }

      console.log(`[grok] イベント: ${event.type}`);

      // pcm16音声をmulawに変換してTwilioに送る
      if (event.type === "response.audio.delta" && streamSid) {
        try {
          const pcmBuf = Buffer.from(event.delta as string, "base64");
          const mulawBuf = pcm16BufferToMulawBuffer(pcmBuf);
          const mulawB64 = mulawBuf.toString("base64");

          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: mulawB64 },
            }));
          }
        } catch (e) {
          console.error("[ws] 音声変換エラー (pcm16→mulaw):", e);
        }
      }

      // 会話テキストをログに追記
      if (event.type === "response.audio_transcript.delta") {
        rawLog += `AI: ${event.delta}\n`;
      }
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        rawLog += `親: ${event.transcript}\n`;
      }

      if (event.type === "error") {
        console.error("[ws] Grok エラーイベント:", JSON.stringify(event));
      }
    });

    grokWs.on("error", (e: Error) => {
      console.error("[ws] Grok WebSocket エラー:", e.message ?? e);
    });
    grokWs.on("unexpected-response", (_req, res) => {
      console.error(`[ws] Grok 接続失敗 HTTP ${res.statusCode}: ${res.statusMessage}`);
      res.on("data", (chunk: Buffer) => console.error("[ws] レスポンス body:", chunk.toString()));
    });
    grokWs.on("close", (code, reason) => {
      console.log(`[ws] Grok WebSocket 切断 code=${code} reason=${reason?.toString()}`);
    });

    // Twilio → Grok（音声: mulaw → pcm16 変換して転送）
    twilioWs.on("message", (data: Buffer) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (event.event === "connected") {
        console.log("[ws] Twilio WebSocket 接続確認");
      }

      if (event.event === "start") {
        const startData = event.start as Record<string, string>;
        streamSid = startData.streamSid;
        callSid   = startData.callSid;
        console.log(`[ws] Twilio Stream 開始 SID=${callSid} streamSid=${streamSid}`);
      }

      // mulawをpcm16に変換してGrokに転送
      if (event.event === "media" && grokWs?.readyState === WebSocket.OPEN) {
        try {
          const mediaData = event.media as Record<string, string>;
          const mulawBuf = Buffer.from(mediaData.payload, "base64");
          const pcmBuf = mulawBufferToPcm16Buffer(mulawBuf);
          grokWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcmBuf.toString("base64"),
          }));
        } catch (e) {
          console.error("[ws] 音声変換エラー (mulaw→pcm16):", e);
        }
      }

      if (event.event === "stop") {
        console.log(`[ws] Twilio Stream 終了 SID=${callSid}`);
        grokWs?.close();
      }
    });

    twilioWs.on("error", (e: Error) => {
      console.error("[ws] Twilio WebSocket エラー:", e.message);
    });

    // 通話終了時：raw_logをSupabaseに保存
    twilioWs.on("close", async () => {
      console.log(`[ws] Twilio WebSocket 切断 callSid=${callSid}`);

      if (callSid && rawLog) {
        await supabase.from("conversations").insert({
          user_id:   userId,
          raw_log:   rawLog,
          call_sid:  callSid,
          called_at: new Date().toISOString(),
        });
        console.log("[ws] raw_log 保存完了");
      }
    });
  });
});

app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
