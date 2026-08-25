/**
 * The one way to reach models/gemini-3.1-flash-live-preview.
 *
 * That model declares exactly one generation method — bidiGenerateContent — so
 * the ordinary REST call every Gemini example shows you does not work on it:
 *
 *     POST /v1beta/models/gemini-3.1-flash-live-preview:generateContent
 *     404  "…or is not supported for generateContent"
 *
 * It is a Live API model, which means a WebSocket session rather than a
 * request/response pair. And it is a *native-audio* Live model, so asking for
 * text out is refused before the session even opens:
 *
 *     setup { responseModalities: ["TEXT"] }
 *     close 1007  "The requested combination of response modalities (TEXT)
 *                  is not supported by the model."
 *
 * The route that works, verified against the live endpoint, is to ask for AUDIO
 * and switch on the Live API's own output transcription. The transcript is the
 * text. It survives everything this console's panels are built on — the rupee
 * sign, "₹8.65 L" shorthand, "• " bullet prefixes, ACC-DEL-4471 style ids — and
 * when the answer is JSON the model skips speaking it entirely and sends only the
 * transcription, so the audio costs nothing. A four-agent investigation came back
 * in 4.1 seconds with zero audio bytes.
 *
 * Everything below exists to make that one exchange look like a function call:
 * open, set up, send one turn, collect the transcript until generation is
 * complete, close.
 */

// Pinned, deliberately, to the single model this project is required to use.
// There is no chain and no catalogue fallback behind it — see the note in
// src/app/api/chat/route.ts about what that costs.
export const GEMINI_MODEL = "models/gemini-3.1-flash-live-preview";

/**
 * The API key, under whichever name the host happens to have used.
 *
 * Google's own tooling is not consistent about this: the AI Studio quickstart
 * says GEMINI_API_KEY, the Node client reads GOOGLE_API_KEY, and the Vercel AI
 * SDK reads GOOGLE_GENERATIVE_AI_API_KEY. Someone adding "the Google API key" to
 * a deployment dashboard picks one of those — or just calls it `Google` — and the
 * console then reports itself unconfigured while the key sits right there in the
 * settings. The only symptom is every answer quietly coming from the local
 * engine, which is a failure that looks like a working deployment.
 *
 * So: the four documented spellings first, and failing those, a scan for a key
 * that is unmistakably a Google one. There are two formats in circulation — the
 * long-standing `AIza` + 35 characters, and the newer AI Studio format, `AQ.`
 * followed by about 50 — and a key issued today is the second kind. Both are
 * specific enough to recognise.
 *
 * The one thing the scan must not do is pick up NEXT_PUBLIC_FIREBASE_API_KEY.
 * That is an `AIza` key — every Firebase web config contains one — and it would
 * authenticate as the wrong client against the wrong API. Anything named for
 * Firebase, and anything NEXT_PUBLIC (a key the browser is allowed to see is by
 * definition not the one guarding a paid model), is excluded before the shape
 * test runs.
 */
const KEY_NAMES = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_AI_API_KEY",
];

/**
 * The two shapes a Google API key comes in: `AQ.` + ~50 characters, which is
 * what AI Studio issues now, and `AIza` + 35, which is what it used to and what
 * Firebase still uses.
 */
const KEY_SHAPE = /^(AQ\.[\w.-]{20,}|AIza[\w-]{30,})$/;

let warnedAboutName = false;

export function geminiKey(): string | undefined {
  for (const name of KEY_NAMES) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }

  const candidates = Object.keys(process.env)
    .filter((n) => !/firebase|next_public/i.test(n))
    .sort()
    // Names that mention Google or Gemini are tried before anything else, so a
    // deployment holding two Google keys still resolves the intended one.
    .sort((a, b) => Number(/gemini|google|ai.?studio/i.test(b)) - Number(/gemini|google|ai.?studio/i.test(a)));

  for (const name of candidates) {
    const value = process.env[name]?.trim();
    if (value && KEY_SHAPE.test(value)) {
      if (!warnedAboutName) {
        warnedAboutName = true;
        // Names only — never the value. Visible in the platform's function logs,
        // which is where someone debugging a deployment is already looking.
        console.warn(
          `[FinGuard] AI key found in ${name}, which is not a name this reads by default. ` +
            `It works, but rename it to GEMINI_API_KEY so the next person does not have to find this line.`
        );
      }
      return value;
    }
  }

  if (!warnedAboutName) {
    warnedAboutName = true;
    const seen = Object.keys(process.env).filter((n) => /gemini|google|ai.?studio|api.?key/i.test(n));
    console.warn(
      `[FinGuard] no AI key found. Env names that looked related: ${seen.join(", ") || "(none)"}. ` +
        `Set GEMINI_API_KEY.`
    );
  }
  return undefined;
}

const HOST = "generativelanguage.googleapis.com";
const SERVICE = "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** Hard ceiling on one exchange, well inside the route handler's 60 seconds. */
const TURN_TIMEOUT_MS = 45_000;

/**
 * How long to keep listening after the model says generation is complete.
 *
 * This exists because of what `turnComplete` actually means on a Live session.
 * The protocol is built for a voice conversation, so the server holds the turn
 * open until the audio it sent would have finished *playing* — not until it has
 * finished generating. Measured on a 223-character answer:
 *
 *     1579ms  first transcription chunk
 *     1580ms  audio part            (55 of them, streamed over 3.9s)
 *     5463ms  generationComplete    ← everything is here
 *    16669ms  turnComplete          ← 11.2s later, waiting out the playback clock
 *
 * Nothing arrives in those 11 seconds. This console never plays the audio; it
 * reads the transcript. So the answer is complete at generationComplete, and the
 * only reason to wait past it is that transcription chunks can trail the signal
 * by a frame or two. 400ms covers that with room to spare — in every turn
 * measured, the last chunk landed before generationComplete, not after — and any
 * chunk that does arrive re-arms the window rather than being cut off.
 */
const SETTLE_GRACE_MS = 400;

export type GeminiTurn = { role: "user" | "model"; text: string };

export type GeminiUsage = { promptTokens: number; totalTokens: number };

export type GeminiResult =
  | { ok: true; text: string; model: string; usage: GeminiUsage | null }
  | {
      ok: false;
      /** WebSocket close code, or 0 when the socket never opened. */
      status: number;
      detail: string;
      rateLimited: boolean;
      /** Set when the quota that ran out is a daily one, which seconds cannot fix. */
      daily: boolean;
      retryMs: number;
      usage: GeminiUsage | null;
    };

/**
 * Node has had a global WebSocket since v22, which is what Vercel runs and what
 * package.json now pins in `engines`, so there is nothing to install and nothing
 * to import.
 *
 * There was a fallback to the `ws` package here. It was removed: `ws` sits in
 * node_modules as somebody's transitive dependency but is absent from
 * package-lock.json, so a clean `npm ci` — which is what Vercel runs — would
 * never have it. A fallback that cannot fire in the one environment it exists
 * for is worse than none, because it reads like insurance. If the runtime really
 * has no WebSocket, the caller degrades to the local analysis engine and says so
 * out loud.
 */
function resolveWebSocket(): typeof WebSocket | null {
  const native = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  return typeof native === "function" ? native : null;
}

/**
 * Google sends JSON, but not always as a text frame: Node's WebSocket delivers a
 * binary frame as a Blob, and that is what actually arrives here most of the
 * time. The string and ArrayBuffer branches cost nothing and mean a runtime that
 * frames it differently still parses.
 */
async function frameText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data && typeof (data as Blob).text === "function") return await (data as Blob).text();
  if (data && typeof (data as { toString: () => string }).toString === "function") {
    return (data as { toString: (enc: string) => string }).toString("utf8");
  }
  return "";
}

// Google reports an exhausted quota as RESOURCE_EXHAUSTED, in the close reason
// or in an error frame. The wording varies; the code does not.
const isQuota = (detail: string) =>
  /RESOURCE_EXHAUSTED|quota|rate.?limit|too many requests|exceeded/i.test(detail);

const isDaily = (detail: string) => /per day|daily|PerDay|RequestsPerDay/i.test(detail);

// A retryDelay comes back as "37s" on the REST surface and sometimes rides along
// in a Live error frame. Worth reading when it is there: it beats guessing.
function retryDelayMs(detail: string): number {
  const m = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(detail) ?? /retry in ([\d.]+)\s*s/i.exec(detail);
  return m ? Math.min(Number(m[1]) * 1000, 30_000) : 0;
}

/**
 * One exchange with the pinned model. No retrying — the caller decides whether a
 * failure is worth another attempt, because that judgement needs to see the
 * request budget and this function only sees one socket.
 *
 * `validate` lets the caller reject an answer that arrived but is unusable: the
 * investigate path needs parseable JSON for four agents, and a model can return
 * prose and still call that a successful turn.
 */
export async function askGemini(opts: {
  apiKey: string;
  system: string;
  turns: GeminiTurn[];
  temperature: number;
  maxOutputTokens: number;
  validate?: (text: string) => boolean;
}): Promise<GeminiResult> {
  const WS = resolveWebSocket();
  if (!WS) {
    return {
      ok: false,
      status: 0,
      detail: "no WebSocket implementation available in this runtime (Node 22+ required)",
      rateLimited: false,
      daily: false,
      retryMs: 0,
      usage: null,
    };
  }

  const url = `wss://${HOST}/ws/${SERVICE}?key=${encodeURIComponent(opts.apiKey)}`;
  let ws: WebSocket;
  try {
    ws = new WS(url);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: String(err),
      rateLimited: false,
      daily: false,
      retryMs: 0,
      usage: null,
    };
  }

  return await new Promise<GeminiResult>((resolve) => {
    const chunks: string[] = [];
    let usage: GeminiUsage | null = null;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: GeminiResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      try {
        ws.close();
      } catch {
        /* the socket is already gone; nothing to do */
      }
      resolve(result);
    };

    const fail = (status: number, detail: string): GeminiResult => ({
      ok: false,
      status,
      detail: detail.slice(0, 400),
      rateLimited: isQuota(detail),
      daily: isQuota(detail) && isDaily(detail),
      retryMs: retryDelayMs(detail),
      usage,
    });

    // An answer that arrived and then failed `validate`. Reported as a distinct
    // outcome so the caller can say "the AI returned something unreadable"
    // rather than "the AI was unreachable" — different problems, different advice.
    const settleWithText = () => {
      const text = chunks.join("").trim();
      if (!text) return finish(fail(0, "the model returned an empty transcript"));
      if (opts.validate && !opts.validate(text)) {
        return finish(fail(422, `unusable answer (${text.length} chars)`));
      }
      finish({ ok: true, text, model: GEMINI_MODEL, usage });
    };

    // Generation has finished and there is text in hand. Wait one short window
    // for a trailing transcription chunk, then answer — see SETTLE_GRACE_MS.
    // A chunk arriving inside the window pushes it out rather than being lost.
    const armGrace = () => {
      if (!chunks.length) return;
      clearTimeout(grace);
      grace = setTimeout(settleWithText, SETTLE_GRACE_MS);
    };

    const timer = setTimeout(() => {
      // Partial text beats nothing: a transcript cut off at the deadline may
      // still satisfy `validate`, and if it doesn't, that is what validate is for.
      if (chunks.length) return settleWithText();
      finish(fail(408, `no complete turn within ${TURN_TIMEOUT_MS}ms`));
    }, TURN_TIMEOUT_MS);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          setup: {
            model: GEMINI_MODEL,
            generationConfig: {
              // AUDIO is the only modality this model accepts. The words come
              // from outputAudioTranscription below, not from an audio decode.
              // One consequence worth knowing before tuning the cap: on a turn
              // the model chooses to speak, maxOutputTokens is spent on audio
              // tokens rather than words — see the note on `maxTokens` in the
              // chat route.
              responseModalities: ["AUDIO"],
              temperature: opts.temperature,
              maxOutputTokens: opts.maxOutputTokens,
            },
            outputAudioTranscription: {},
            systemInstruction: { parts: [{ text: opts.system }] },
          },
        })
      );
    };

    ws.onmessage = async (event: MessageEvent) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(await frameText(event.data));
      } catch {
        return;
      }

      // The session is live; send the conversation as one turn batch.
      if (msg.setupComplete) {
        ws.send(
          JSON.stringify({
            clientContent: {
              turns: opts.turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
              turnComplete: true,
            },
          })
        );
        return;
      }

      if (msg.usageMetadata) {
        usage = {
          promptTokens: Number(msg.usageMetadata.promptTokenCount) || 0,
          totalTokens: Number(msg.usageMetadata.totalTokenCount) || 0,
        };
      }

      if (msg.error) {
        return finish(fail(Number(msg.error.code) || 500, JSON.stringify(msg.error)));
      }

      // Google's warning that it is about to hang up. Whatever has arrived is all
      // there will be.
      if (msg.goAway) {
        return chunks.length ? settleWithText() : finish(fail(503, JSON.stringify(msg.goAway)));
      }

      const sc = msg.serverContent;
      if (!sc) return;

      if (sc.outputTranscription?.text) {
        chunks.push(sc.outputTranscription.text);
        // Only matters once generation is already done: keeps the grace window
        // open for as long as text is still arriving.
        if (grace) armGrace();
      }
      // Belt and braces: if a future revision of this model does return text
      // parts directly, take them too rather than dropping the answer.
      for (const part of sc.modelTurn?.parts ?? []) {
        if (typeof part?.text === "string" && part.text) chunks.push(part.text);
      }

      // The answer is complete here. `turnComplete` comes later — after the
      // audio would have finished playing — and this console never plays it.
      if (sc.generationComplete) armGrace();

      // Still honoured, because a turn can complete without ever announcing
      // generationComplete: an empty answer, or a revision of the model that
      // stops sending it.
      if (sc.turnComplete) settleWithText();
    };

    ws.onerror = () => {
      // The close frame carries the reason; onerror has none worth reporting.
    };

    ws.onclose = (event: CloseEvent) => {
      if (settled) return;
      if (chunks.length) return settleWithText();
      const reason = event.reason || "(no reason given)";
      finish(fail(event.code || 1006, `socket closed ${event.code}: ${reason}`));
    };
  });
}
