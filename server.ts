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

// ── 音声変換ユーティリティ ──────────────────────────────────────────

// μLaw → PCM16
function mulawToLinear(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exp  = (u >> 4) & 0x07;
  const mant = u & 0x0f;
  let s = ((mant << 3) + 0x84) << exp;
  s -= 0x84;
  return sign ? -s : s;
}

// PCM16 → μLaw
function linearToMulaw(s: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

// μLaw Buffer → PCM16 Buffer（8kHz）
function mulawToPcm16(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    out.writeInt16LE(mulawToLinear(buf[i]), i * 2);
  }
  return out;
}

// PCM16 Buffer → μLaw Buffer
function pcm16ToMulaw(buf: Buffer): Buffer {
  const samples = Math.floor(buf.length / 2);
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = linearToMulaw(buf.readInt16LE(i * 2));
  }
  return out;
}

// PCM16 アップサンプリング: 8000Hz → 24000Hz（線形補間）
function upsample8kTo24k(buf: Buffer): Buffer {
  const inSamples = Math.floor(buf.length / 2);
  const out = Buffer.alloc(inSamples * 3 * 2);
  for (let i = 0; i < inSamples; i++) {
    const s0 = buf.readInt16LE(i * 2);
    const s1 = i + 1 < inSamples ? buf.readInt16LE((i + 1) * 2) : s0;
    out.writeInt16LE(s0,                          i * 6);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) / 3),  i * 6 + 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * 2 / 3), i * 6 + 4);
  }
  return out;
}

// PCM16 ダウンサンプリング: 24000Hz → 8000Hz（3サンプル平均）
function downsample24kTo8k(buf: Buffer): Buffer {
  const inSamples = Math.floor(buf.length / 2);
  const outSamples = Math.floor(inSamples / 3);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const a = buf.readInt16LE(i * 6);
    const b = buf.readInt16LE(i * 6 + 2);
    const c = buf.readInt16LE(i * 6 + 4);
    out.writeInt16LE(Math.round((a + b + c) / 3), i * 2);
  }
  return out;
}

// Twilio（μLaw 8kHz）→ Grok（PCM16 24kHz）
function twilioToGrok(base64Mulaw: string): string {
  const mulaw = Buffer.from(base64Mulaw, "base64");
  const pcm8k = mulawToPcm16(mulaw);
  const pcm24k = upsample8kTo24k(pcm8k);
  return pcm24k.toString("base64");
}

// Grok（PCM16 24kHz）→ Twilio（μLaw 8kHz）
function grokToTwilio(base64Pcm24k: string): string {
  const pcm24k = Buffer.from(base64Pcm24k, "base64");
  const pcm8k = downsample24kTo8k(pcm24k);
  const mulaw = pcm16ToMulaw(pcm8k);
  return mulaw.toString("base64");
}

// ── WebSocket ブリッジ ────────────────────────────────────────────

app.register(async (fastify) => {
  fastify.get("/stream", { websocket: true }, (twilioWs, req) => {
    const url = new URL(`ws://localhost${req.url}`);
    const userId       = url.searchParams.get("userId")       ?? "";
    const systemPrompt = decodeURIComponent(url.searchParams.get("systemPrompt") ?? "");

    let callSid   = "";
    let rawLog    = "";
    let grokWs: WebSocket | null = null;
    let streamSid = "";
    let farewellSent = false;

    console.log(`[ws] 接続開始 userId=${userId}`);

    // 最大通話時間タイマー（4分30秒で別れの挨拶、5分で強制切断）
    const MAX_CALL_MS    = 5 * 60 * 1000;
    const FAREWELL_MS    = 4 * 60 * 1000 + 30 * 1000;

    const farewellTimer = setTimeout(() => {
      if (farewellSent || grokWs?.readyState !== WebSocket.OPEN) return;
      farewellSent = true;
      console.log("[ws] 通話時間終了：別れの挨拶を送信");

      // Grokに別れの挨拶を話させる
      grokWs!.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "時間になりました。『そろそろお時間です。今日もお話できてよかったです。また明日お電話しますね。お体に気をつけてください。』と言って会話を終了してください。",
          }],
        },
      }));
      grokWs!.send(JSON.stringify({ type: "response.create" }));
    }, FAREWELL_MS);

    const forceCloseTimer = setTimeout(() => {
      console.log("[ws] 通話時間終了：強制切断");
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
      grokWs?.close();
    }, MAX_CALL_MS);

    const clearTimers = () => {
      clearTimeout(farewellTimer);
      clearTimeout(forceCloseTimer);
    };

    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      console.error("[ws] XAI_API_KEY が設定されていません");
      twilioWs.close();
      return;
    }

    grokWs = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-4-1-fast-non-reasoning", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    grokWs.on("open", () => {
      console.log("[ws] Grok Voice API 接続完了");

      grokWs!.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: `あなたは離れて暮らす高齢者の毎日の話し相手です。
以下のルールを必ず守ってください。

・必ず日本語のみで話してください
・電話がつながったら必ず以下の流れで話してください
  1. 挨拶：『おはようございます。毎日お電話させていただいているみまもりです。』
  2. 世間話：天気・季節・ニュース・食べ物・花など毎日違う話題を一つ振る
     例：『今日は桜がきれいな時期ですね』『最近少し暖かくなってきましたね』など
  3. 体調確認：『今日もお体の具合はいかがですか？』
・ゆっくり、はっきり、温かく話してください
・体調・食事・睡眠・気になることを自然に聞いてください
・相手が話したことに共感しながら会話を続けてください
・会話は3〜5分程度を目安にしてください
・別れの挨拶は『今日もお話できてよかったです。また明日お電話しますね。お体に気をつけてください。』にしてください`,
          voice: "Eve",
          turn_detection: { type: "server_vad" },
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
        },
      }));
      console.log("[ws] session.update 送信完了");

      grokWs!.send(JSON.stringify({ type: "response.create" }));
      console.log("[ws] response.create 送信完了");
    });

    // Grok → Twilio
    grokWs.on("message", (data: Buffer) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }

      console.log(`[grok] イベント: ${event.type}`);

      if (event.type === "response.output_audio.delta" && streamSid) {
        try {
          const mulawB64 = grokToTwilio(event.delta as string);
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: mulawB64 },
            }));
          }
        } catch (e) {
          console.error("[ws] 音声変換エラー (Grok→Twilio):", e);
        }
      }

      if (event.type === "response.output_audio_transcript.delta") {
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
      console.error("[ws] Grok WebSocket エラー:", e.message);
    });
    grokWs.on("unexpected-response", (_req, res) => {
      console.error(`[ws] Grok 接続失敗 HTTP ${res.statusCode}: ${res.statusMessage}`);
      res.on("data", (chunk: Buffer) => console.error("[ws] レスポンス body:", chunk.toString()));
    });
    grokWs.on("close", (code, reason) => {
      console.log(`[ws] Grok WebSocket 切断 code=${code} reason=${reason?.toString()}`);
    });

    // Twilio → Grok
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
        const s = event.start as Record<string, string>;
        streamSid = s.streamSid;
        callSid   = s.callSid;
        console.log(`[ws] Twilio Stream 開始 SID=${callSid}`);
      }

      if (event.event === "media" && grokWs?.readyState === WebSocket.OPEN) {
        try {
          const media = event.media as Record<string, string>;
          const pcm24kB64 = twilioToGrok(media.payload);
          grokWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcm24kB64,
          }));
        } catch (e) {
          console.error("[ws] 音声変換エラー (Twilio→Grok):", e);
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

    twilioWs.on("close", async () => {
      clearTimers();
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
