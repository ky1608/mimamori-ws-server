import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";

const app = Fastify({ logger: true });
app.register(fastifyWebsocket);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
  : null;

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

if (twilioClient) {
  console.log("[ws] Twilio client 初期化済み");
} else {
  console.warn(
    `[ws] Twilio client 未初期化: TWILIO_ACCOUNT_SID=${process.env.TWILIO_ACCOUNT_SID ? "set" : "missing"}, TWILIO_AUTH_TOKEN=${process.env.TWILIO_AUTH_TOKEN ? "set" : "missing"}`,
  );
}

const CONSENT_SYSTEM_PROMPT = `あなたは今から高齢者に初めてお電話するAIです。
必ず日本語で話してください。
以下のスクリプトを正確に読んでください。

『はじめまして。私はmimamoriというAIです。
お子様がご両親のことを心配されて、
このサービスに登録してくださいました。

お電話して、お体の具合や
日々のことをお聞きするサービスです。

お話の内容はお子様にお伝えしますが、
他の方にお伝えすることはありません。

また将来的に、個人が特定できない形で
健康に関する研究に役立てる場合があります。
その際はあらためてご確認いたします。

ご利用いただけますか？
よろしければ「はい」とおっしゃってください。』

相手が「はい」と答えたら：
「ありがとうございます。それでは早速ですが、
今日のお体の具合はいかがですか？」
と言って通常の見守り会話に移行してください。
通常の会話では体調確認・アドバイス・私生活の確認を行ってください。

相手が「いいえ」または拒否した場合：
「承知しました。またご検討ください。
失礼いたします。」
と言ってすぐに電話を終了してください。
電話終了はTwilio側でhangupしてください。`;

function isConsentAccepted(rawLog: string): boolean {
  const userSpeech = rawLog
    .split("\n")
    .filter((line) => line.startsWith("親:"))
    .map((line) => line.replace(/^親:\s*/, ""))
    .join(" ");

  const hasNo =
    /いいえ|いや|嫌|不要|結構です|同意しません|やめます|やめておきます/u.test(userSpeech);
  const hasYes =
    /はい|お願いします|同意します|承知しました|大丈夫です|利用します/u.test(userSpeech);

  return hasYes && !hasNo;
}

function isConsentRejected(text: string): boolean {
  return /いいえ|いや|嫌|不要|結構です|同意しません|やめます|やめておきます|拒否/u.test(text);
}

async function forceHangupByTwilio(callSid: string, reason: string): Promise<void> {
  if (!twilioClient) {
    console.warn(`[ws] Twilio client が未初期化のためhangupスキップ reason=${reason}`);
    return;
  }
  if (!callSid) {
    console.warn(`[ws] callSid が空のためhangupスキップ reason=${reason}`);
    return;
  }

  try {
    const updated = await twilioClient.calls(callSid).update({ status: "completed" });
    console.log(
      `[ws] Twilio hangup完了 reason=${reason} callSid=${callSid} twilioStatus=${updated.status}`,
    );
  } catch (e: unknown) {
    const err = e as {
      code?: number;
      status?: number;
      message?: string;
      moreInfo?: string;
      stack?: string;
    };
    console.error(
      "[ws] Twilio hangup失敗:",
      JSON.stringify({
        reason,
        callSid,
        code: err?.code,
        status: err?.status,
        message: err?.message,
        moreInfo: err?.moreInfo,
      }),
    );
    if (err?.stack) {
      console.error("[ws] Twilio hangup stack:", err.stack);
    }
  }
}

async function fetchParentFirstName(userId: string): Promise<string> {
  if (!userId) return "";

  try {
    const { data, error } = await supabase
      .from("users")
      .select("parent_first_name")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("[ws] parent_first_name取得エラー:", error);
      return "";
    }

    return (data?.parent_first_name ?? "").trim();
  } catch (e) {
    console.error("[ws] parent_first_name取得例外:", e);
    return "";
  }
}

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
    // URLクエリパラメータからuserIdとlastConversationを取得
    const url = new URL(`ws://localhost${req.url}`);
    let userId = url.searchParams.get("userId") ?? "";
    let lastConversation = decodeURIComponent(url.searchParams.get("lastConversation") ?? "");
    let consentFlow = url.searchParams.get("consentFlow") === "1";

    let callSid   = "";
    let rawLog    = "";
    let grokWs: WebSocket | null = null;
    let streamSid = "";
    let farewellSent = false;
    let forcedHangupRequested = false;
    let parentFirstName = "";

    console.log(`[ws] 接続開始 req.url=${req.url} userId=${userId}`);

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

    grokWs.on("open", async () => {
      console.log("[ws] Grok Voice API 接続完了");
      if (userId) {
        parentFirstName = await fetchParentFirstName(userId);
      }
      const displayName = parentFirstName || "相手";

      const regularSystemPrompt = `${lastConversation ? `前回の会話メモ：${lastConversation}\n上記メモがあるため、流れの2に従い具体的に引用して話してください。\n\n` : ""}あなたは離れて暮らす高齢者の毎日の話し相手です。
以下のルールを必ず守ってください。

・必ず日本語のみで話してください
・「あら」「まあ」「そうですか」「それは大変でしたね」などの感嘆詞を自然に使ってください
・「${displayName}さん」と名前を呼ぶのは会話全体で最大2回までにしてください

・電話がつながったら必ず以下の流れで話してください

  1. 挨拶：おはようございます。毎日お電話させていただいているmimamoriです。
  
  2. 前回の会話を引用（前回メモがある場合）：
     先日○○とおっしゃっていましたが、その後いかがですか？
     と具体的に前回の内容に触れる
  
  3. 今日の話題：
     日本の明るいニュースをふる
     雑談の話題は毎回必ず違うものにしてください。
     天気・季節・食べ物・スポーツ・地域の話題・健康情報など
     バリエーションを持たせてください。
     前回と同じ話題は絶対に使わないでください。
     今日の日本の最新ニュースや季節感のある話題を優先してください。
  
  4. 体調確認：今日のお体の具合はいかがですか？
     ・特にないと言われたら終わりにせず
       お食事はしっかり食べられていますか？
       夜はよく眠れていますか？
       今日はどんな一日でしたか？
       と別の質問で会話を続ける
     ・体調不良には共感プラス具体的なアドバイスを一つ
     ・他に気になるところはありますか？と必ず聞く
     ・質問の内容や言い回しは毎回変えてください。
       同じ質問を繰り返さず、前回の会話を踏まえて
       自然な流れで聞いてください。
       例はあくまで参考で、そのまま読み上げないでください。
  
  5. 私生活の確認：
     最近、生活の中で困っていることや不安なことはありますか？
     ・相手の回答をしっかり聞いて共感する
     ・回答後に「他に何かお困りのことはありますか？」と必ず聞く
     ・「ない」と言われたら締めの挨拶に入る
     ・ないと言われる前に締めの挨拶に入らないこと
     ・質問の内容や言い回しは毎回変えてください。
       同じ質問を繰り返さず、前回の会話を踏まえて
       自然な流れで聞いてください。
       例はあくまで参考で、そのまま読み上げないでください。
  
  6. 締めの挨拶と強制終了：
     体調確認と私生活確認が終わったら必ず以下の挨拶をして電話を終了してください。
     『今日もお話できてよかったです。またお電話しますね。お体に気をつけてください。』
     挨拶が終わったらTwilioのcallSidを使って通話を強制終了してください。

・ゆっくり、はっきり、温かく話してください
・会話は3〜4分程度を目安にしてください`;

      grokWs!.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: consentFlow ? CONSENT_SYSTEM_PROMPT : regularSystemPrompt,
          voice: "Eve",
          turn_detection: { type: "server_vad" },
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          input_audio_transcription: { model: "whisper-1" },
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

      // AIの発話テキスト（完全版をdoneで取得）
      if (event.type === "response.output_audio_transcript.done") {
        if (event.transcript) {
          const aiTranscript = String(event.transcript);
          rawLog += `AI: ${aiTranscript}\n`;
          console.log(`[ws] AI発話ログ: ${aiTranscript.slice(0, 50)}...`);

          const closingPatterns = [
            "今日もお話できてよかったです",
            "またお電話します",
            "お体に気をつけてください",
          ];
          const shouldHangupByClosing =
            !consentFlow &&
            !forcedHangupRequested &&
            closingPatterns.some((p) => aiTranscript.includes(p));

          if (shouldHangupByClosing) {
            forcedHangupRequested = true;
            console.log(`[ws] 締め挨拶を検知。Twilio強制切断を実行 callSid=${callSid}`);
            void forceHangupByTwilio(callSid, "closing-greeting");
          }
        }
      }
      // ユーザーの発話テキスト
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        if (event.transcript) {
          const transcript = String(event.transcript);
          rawLog += `親: ${transcript}\n`;
          console.log(`[ws] ユーザー発話ログ: ${transcript.slice(0, 50)}...`);

          if (consentFlow && !forcedHangupRequested && isConsentRejected(transcript)) {
            forcedHangupRequested = true;
            console.log(`[ws] 同意拒否を検知。Twilio強制切断を実行 callSid=${callSid}`);
            void forceHangupByTwilio(callSid, "consent-rejected");
          }
        }
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
        const s = event.start as {
          streamSid: string;
          callSid: string;
          customParameters?: Record<string, string>;
        };
        streamSid = s.streamSid;
        callSid   = s.callSid;

        // URLパラメータで取れなかった場合はcustomParametersから取得
        if (!userId && s.customParameters?.userId) {
          userId = s.customParameters.userId;
          console.log(`[ws] customParametersからuserId取得: ${userId}`);
        }
        if (!lastConversation && s.customParameters?.lastConversation) {
          lastConversation = s.customParameters.lastConversation;
        }
        if (!parentFirstName && userId) {
          void fetchParentFirstName(userId).then((name) => {
            parentFirstName = name;
          });
        }
        if (s.customParameters?.consentFlow === "1") {
          consentFlow = true;
        }
        console.log(`[ws] Twilio Stream 開始 SID=${callSid} userId=${userId} consentFlow=${consentFlow}`);
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

      if (!callSid || !rawLog) {
        console.log("[ws] rawLogなし：保存・要約スキップ");
        return;
      }

      const webBaseUrl = process.env.WEB_BASE_URL ?? "https://web-henna-nine-23.vercel.app";
      const calledAt = new Date().toISOString();

      if (consentFlow && isConsentAccepted(rawLog)) {
        if (!supabaseAdmin) {
          console.error("[ws] SUPABASE_SERVICE_ROLE_KEY が未設定のため同意更新をスキップ");
        } else {
          const { error: consentUpdateError } = await supabaseAdmin
            .from("users")
            .update({
              consent_service: true,
              consent_recorded_at: calledAt,
            })
            .eq("id", userId);

          if (consentUpdateError) {
            console.error("[ws] 同意更新エラー:", consentUpdateError);
          } else {
            console.log("[ws] 同意更新完了:", userId);
          }
        }
      }

      // ① 要約APIを呼ぶ
      let summary = "";
      let score = "普通";
      let concern = "特になし";
      try {
        const res = await fetch(`${webBaseUrl}/api/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, rawLog, calledAt, callSid }),
        });
        if (res.ok) {
          const data = await res.json() as { summary: string; score: string; concern: string };
          summary = data.summary;
          score   = data.score;
          concern = data.concern;
          console.log("[ws] 要約完了:", summary);
        } else {
          console.error("[ws] 要約API失敗:", await res.text());
        }
      } catch (e) {
        console.error("[ws] 要約API呼び出しエラー:", e);
      }

      // ② LINE通知を送る
      try {
        const { data: user } = await supabase
          .from("users")
          .select("parent_name, line_user_id")
          .eq("id", userId)
          .single();

        if (user?.line_user_id) {
          const callTime = new Date().toLocaleTimeString("ja-JP", {
            hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo",
          });
          const scoreKey = score === "良い" ? "good" : score === "注意" ? "caution" : "normal";
          const lineBody = concern !== "特になし" ? `${summary}\n\n⚠️ 気になる点：${concern}` : summary;

          await fetch(`${webBaseUrl}/api/line-notify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              lineUserId: user.line_user_id,
              parentName: user.parent_name,
              score: scoreKey,
              summary: lineBody,
              callTime,
            }),
          });
          console.log("[ws] LINE通知送信完了");
        } else {
          console.log("[ws] LINE未連携のため通知スキップ");
        }
      } catch (e) {
        console.error("[ws] LINE通知エラー:", e);
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
