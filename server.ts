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

// Twilio Media Stream → Grok Voice API ブリッジ
app.register(async (fastify) => {
  fastify.get("/stream", { websocket: true }, (twilioWs, req) => {
    const url = new URL(`ws://localhost${req.url}`);
    const userId        = url.searchParams.get("userId")       ?? "";
    const systemPrompt  = decodeURIComponent(url.searchParams.get("systemPrompt") ?? "");

    let callSid   = "";
    let rawLog    = "";
    let grokWs: WebSocket | null = null;
    let streamSid = "";

    console.log(`[ws] 接続開始 userId=${userId}`);

    // Grok Voice API の WebSocket に接続
    grokWs = new WebSocket("wss://api.x.ai/v1/realtime", {
      headers: {
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      },
    });

    grokWs.on("open", () => {
      console.log("[ws] Grok Voice API 接続完了");

      // セッション設定
      grokWs!.send(JSON.stringify({
        type: "session.update",
        session: {
          model: "grok-2-voice-preview",
          voice: "Eve",
          instructions: systemPrompt,
          input_audio_format: "mulaw",
          output_audio_format: "mulaw",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            silence_duration_ms: 800,
          },
        },
      }));
    });

    // Grok → Twilio（音声・テキスト）
    grokWs.on("message", (data: Buffer) => {
      const event = JSON.parse(data.toString());

      // 音声データをTwilioに送る
      if (event.type === "response.audio.delta" && streamSid) {
        const twilioMsg = JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: event.delta },
        });
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(twilioMsg);
        }
      }

      // 会話テキストをログに追記
      if (event.type === "response.audio_transcript.delta") {
        rawLog += `AI: ${event.delta}\n`;
      }
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        rawLog += `親: ${event.transcript}\n`;
      }
    });

    grokWs.on("error", (e) => console.error("[ws] Grok WebSocket エラー:", e));
    grokWs.on("close", () => console.log("[ws] Grok WebSocket 切断"));

    // Twilio → Grok（音声）
    twilioWs.on("message", (data: Buffer) => {
      const event = JSON.parse(data.toString());

      if (event.event === "start") {
        streamSid = event.start.streamSid;
        callSid   = event.start.callSid;
        console.log(`[ws] Twilio Stream 開始 SID=${callSid}`);
      }

      // Twilioの音声をGrokに転送
      if (event.event === "media" && grokWs?.readyState === WebSocket.OPEN) {
        grokWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: event.media.payload,
        }));
      }

      if (event.event === "stop") {
        console.log(`[ws] Twilio Stream 終了 SID=${callSid}`);
        grokWs?.close();
      }
    });

    // 通話終了時：raw_logをSupabaseに保存
    twilioWs.on("close", async () => {
      console.log(`[ws] Twilio WebSocket 切断 callSid=${callSid}`);

      if (callSid && rawLog) {
        await supabase.from("conversations").insert({
          user_id:  userId,
          raw_log:  rawLog,
          call_sid: callSid,
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
