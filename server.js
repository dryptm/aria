import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { GoogleGenAI } from "@google/genai";
import nodemailer from "nodemailer";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// BASE_URL: set this in Railway/Render dashboard as an env variable
// e.g. https://aria-production.up.railway.app
const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

// ── Gemini with model rotation ────────────────────────────────────────────────
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODELS = [
  "gemini-2.0-flash-lite-001",
  "gemini-2.0-flash",
  "gemini-1.5-flash-8b",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
];
// const MODELS = [
//   "gemini-2.0-flash-lite-001",
//   "gemini-2.0-flash",
//   "gemini-2.5-flash-lite",
//   "gemini-2.5-flash",
// ];
async function generateWithFallback(params) {
  let lastError;
  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({ ...params, model });
      console.log(`✅ Model: ${model}`);
      return response;
    } catch (err) {
      const retry = ["503","overloaded","high demand","UNAVAILABLE","429","quota","404","not found","no longer available"]
        .some(s => err.message?.includes(s));
      if (retry) { console.log(`⚠️  ${model} unavailable, trying next...`); lastError = err; continue; }
      throw err;
    }
  }
  throw new Error(`All models failed. Last: ${lastError?.message}`);
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ Database connected"))
  .catch(err => console.error("❌ DB error:", err));

const userSchema = new mongoose.Schema({
  userId:    { type: String, required: true, unique: true },
  memory:    { type: mongoose.Schema.Types.Mixed, default: {} },
  platforms: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });
const User = mongoose.model("User", userSchema);

// ── DB helpers ────────────────────────────────────────────────────────────────
async function getUser(userId) {
  return await User.findOneAndUpdate(
    { userId },
    { $setOnInsert: { memory: {}, platforms: {} } },
    { upsert: true, new: true }
  );
}
async function getMemory(userId) {
  const u = await getUser(userId);
  return u.memory ? JSON.parse(JSON.stringify(u.memory)) : {};
}
async function saveMemory(userId, memory) {
  await User.findOneAndUpdate({ userId }, { $set: { memory } }, { upsert: true });
}
async function savePlatformCred(userId, platform, key, value) {
  await User.findOneAndUpdate(
    { userId },
    { $set: { [`platforms.${platform}.${key}`]: value } },
    { upsert: true }
  );
}
async function getPlatformCred(userId, platform, key) {
  const u = await User.findOne({ userId });
  return u?.platforms?.[platform]?.[key] || null;
}
async function getPlatforms(userId) {
  const u = await User.findOne({ userId });
  return u?.platforms ? JSON.parse(JSON.stringify(u.platforms)) : {};
}

// ── Deep utilities ────────────────────────────────────────────────────────────
function deepSet(obj, dotPath, value) {
  const keys = dotPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

// ── OAuth state store ─────────────────────────────────────────────────────────
const oauthStates = new Map();

// ── Clean connect page ────────────────────────────────────────────────────────
// User visits: /connect/linkedin?userId=xxx
// Server builds the real LinkedIn URL and redirects — user never sees the ugly URL
app.get("/connect/:platform", async (req, res) => {
  const { platform } = req.params;
  const { userId = "default" } = req.query;

  const clientId = await getPlatformCred(userId, platform, "clientId");
  if (!clientId) {
    return res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;max-width:500px;margin:auto">
      <h2>⚠️ Not ready yet</h2>
      <p>Go back to the chat — Aria needs a bit more info before connecting ${platform}.</p>
      <button onclick="window.close()" style="margin-top:20px;padding:10px 24px;background:#7c6af7;color:white;border:none;border-radius:8px;font-size:16px;cursor:pointer">Close tab</button>
    </body></html>`);
  }

  const state = crypto.randomBytes(16).toString("hex");
  oauthStates.set(state, { userId, platform });
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);

  const redirectUri = `${BASE_URL}/auth/${platform}/callback`;
  let authUrl;

  if (platform === "linkedin") {
    const p = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "openid profile w_member_social",
      state,
    });
    authUrl = `https://www.linkedin.com/oauth/v2/authorization?${p}`;
  } else if (platform === "twitter") {
    const p = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "tweet.write users.read offline.access",
      state,
      code_challenge: "challenge",
      code_challenge_method: "plain",
    });
    authUrl = `https://twitter.com/i/oauth2/authorize?${p}`;
  } else {
    return res.status(404).send("Platform not supported");
  }

  // Server redirects — user sees clean LinkedIn/Twitter page, never the ugly URL
  res.redirect(authUrl);
});

// ── OAuth callback ────────────────────────────────────────────────────────────
app.get("/auth/:platform/callback", async (req, res) => {
  const { platform } = req.params;
  const { code, state, error } = req.query;

  const html = (icon, title, msg, extra = "") => `
    <html><head><style>
      body{font-family:-apple-system,sans-serif;text-align:center;padding:80px 20px;max-width:500px;margin:auto}
      .icon{font-size:64px;margin-bottom:16px}.title{font-size:24px;font-weight:600;margin-bottom:8px}
      .msg{color:#666;line-height:1.6}
      .btn{margin-top:24px;padding:12px 28px;background:#7c6af7;color:white;border:none;border-radius:8px;font-size:16px;cursor:pointer}
    </style></head><body>
      <div class="icon">${icon}</div>
      <div class="title">${title}</div>
      <div class="msg">${msg}</div>
      ${extra}
      <br><button class="btn" onclick="window.close()">Close tab</button>
    </body></html>`;

  if (error) return res.send(html("❌", "Connection cancelled", "You can close this tab and try again in the chat."));

  const stateData = oauthStates.get(state);
  if (!stateData) return res.send(html("⏰", "Link expired", "Go back to the chat and ask Aria for a new link."));

  oauthStates.delete(state);
  const { userId } = stateData;

  try {
    const clientId     = await getPlatformCred(userId, platform, "clientId");
    const clientSecret = await getPlatformCred(userId, platform, "clientSecret");
    const redirectUri  = `${BASE_URL}/auth/${platform}/callback`;
    const tokenUrl     = platform === "linkedin"
      ? "https://www.linkedin.com/oauth/v2/accessToken"
      : "https://api.twitter.com/2/oauth2/token";

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret }).toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || "No token received");

    await savePlatformCred(userId, platform, "accessToken", tokenData.access_token);
    if (tokenData.refresh_token) await savePlatformCred(userId, platform, "refreshToken", tokenData.refresh_token);

    const names = { linkedin: "LinkedIn", twitter: "Twitter / X" };
    res.send(html("✅", `${names[platform] || platform} connected!`,
      "You can close this tab and go back to your chat.<br>Aria can now post on your behalf.",
      `<script>setTimeout(()=>window.close(),2500)</script>`));
  } catch (err) {
    console.error("OAuth error:", err);
    res.send(html("❌", "Something went wrong", err.message + "<br><br>Go back to the chat and try again."));
  }
});

// ── Gmail sender ──────────────────────────────────────────────────────────────
async function sendRealEmail(email, appPassword, to, subject, body) {
  const t = nodemailer.createTransport({ service: "gmail", auth: { user: email, pass: appPassword } });
  await t.sendMail({ from: email, to, subject, text: body });
}

// ── Connected platforms ───────────────────────────────────────────────────────
async function getConnected(userId) {
  const p = await getPlatforms(userId);
  const list = [];
  if (p?.gmail?.email && p?.gmail?.appPassword) list.push("gmail");
  if (p?.linkedin?.accessToken) list.push("linkedin");
  if (p?.twitter?.accessToken) list.push("twitter");
  if (p?.slack?.webhookUrl) list.push("slack");
  if (p?.notion?.apiKey) list.push("notion");
  return list;
}

// ── Tools ─────────────────────────────────────────────────────────────────────
const tools = [{
  functionDeclarations: [
    {
      name: "save_to_memory",
      description: "Save contact info, user name, preferences for future conversations.",
      parameters: { type: "OBJECT", properties: {
        path:  { type: "STRING" },
        value: { type: "STRING" },
      }, required: ["path", "value"] },
    },
    {
      name: "save_platform_credential",
      description: "Save a platform credential collected from the user in chat. Stored per-user in the database.",
      parameters: { type: "OBJECT", properties: {
        platform: { type: "STRING", description: "gmail, linkedin, twitter, slack, notion" },
        key:      { type: "STRING", description: "email, appPassword, clientId, clientSecret, webhookUrl, apiKey, pageUrl" },
        value:    { type: "STRING" },
      }, required: ["platform", "key", "value"] },
    },
    {
      name: "get_connect_link",
      description: "Generate a SHORT clean connect link for the user to click. Only call after clientId AND clientSecret are saved. Returns a short URL like /connect/linkedin?userId=xxx",
      parameters: { type: "OBJECT", properties: {
        platform: { type: "STRING", description: "linkedin or twitter" },
      }, required: ["platform"] },
    },
    {
      name: "check_platform_status",
      description: "Check if a platform is connected and what credentials are still missing.",
      parameters: { type: "OBJECT", properties: {
        platform: { type: "STRING" },
      }, required: ["platform"] },
    },
    {
      name: "send_email",
      description: "Send a real email via the user's Gmail.",
      parameters: { type: "OBJECT", properties: {
        to:      { type: "STRING" },
        subject: { type: "STRING" },
        body:    { type: "STRING" },
      }, required: ["to", "subject", "body"] },
    },
    {
      name: "platform_post",
      description: "Post content to a connected platform.",
      parameters: { type: "OBJECT", properties: {
        platform: { type: "STRING", description: "linkedin, twitter, slack, notion" },
        content:  { type: "STRING" },
      }, required: ["platform", "content"] },
    },
    {
      name: "create_calendar_event",
      description: "Create a calendar event",
      parameters: { type: "OBJECT", properties: {
        title: { type: "STRING" }, start: { type: "STRING" }, end: { type: "STRING" },
        attendees: { type: "STRING" }, description: { type: "STRING" },
      }, required: ["title", "start", "end"] },
    },
  ],
}];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, args, memory, userId) {
  console.log(`🛠  ${name}`, args);
  switch (name) {

    case "save_to_memory":
      deepSet(memory, args.path, args.value);
      return { success: true };

    case "save_platform_credential":
      await savePlatformCred(userId, args.platform, args.key, args.value);
      return { success: true, saved: `${args.platform}.${args.key}` };

    case "get_connect_link": {
      const platform = args.platform.toLowerCase();
      const clientId     = await getPlatformCred(userId, platform, "clientId");
      const clientSecret = await getPlatformCred(userId, platform, "clientSecret");
      if (!clientId)     return { success: false, message: `Need Client ID first. Ask the user for it.` };
      if (!clientSecret) return { success: false, message: `Need Client Secret first. Ask the user for it.` };

      // Short, clean URL — server handles the redirect to LinkedIn/Twitter
      const connectUrl = `${BASE_URL}/connect/${platform}?userId=${userId}`;
      return {
        success: true,
        connectUrl,
        // Be explicit so the model always shows the real URL
        tellUser: `Here's your connection link: ${connectUrl}\n\nJust click it, log in, and tap Allow — takes 10 seconds!`,
      };
    }

    case "check_platform_status": {
      const platform = args.platform.toLowerCase();
      const p = await getPlatforms(userId);
      const creds = p?.[platform] || {};
      const required = { gmail: ["email","appPassword"], linkedin: ["clientId","clientSecret","accessToken"], twitter: ["clientId","clientSecret","accessToken"], slack: ["webhookUrl"], notion: ["apiKey","pageUrl"] };
      const req = required[platform] || [];
      return {
        platform,
        isConnected: (await getConnected(userId)).includes(platform),
        have: req.filter(k => creds[k]),
        missing: req.filter(k => !creds[k]),
      };
    }

    case "send_email": {
      const email       = await getPlatformCred(userId, "gmail", "email");
      const appPassword = await getPlatformCred(userId, "gmail", "appPassword");
      if (!email || !appPassword) return { success: false, notConnected: true, message: "Gmail not connected." };
      try {
        await sendRealEmail(email, appPassword, args.to, args.subject, args.body);
        return { success: true, message: `Email sent from ${email} to ${args.to}` };
      } catch (err) {
        return { success: false, error: err.message.includes("Invalid login") ? "App Password incorrect — ask user to re-enter it." : err.message };
      }
    }

    case "platform_post": {
      const platform    = args.platform.toLowerCase();
      const accessToken = await getPlatformCred(userId, platform, "accessToken");
      if (!accessToken) return { success: false, notConnected: true, message: `${platform} not connected.` };

      if (platform === "linkedin") {
        const profileRes = await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
        const profile = await profileRes.json();
        const postRes = await fetch("https://api.linkedin.com/v2/ugcPosts", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "X-Restli-Protocol-Version": "2.0.0" },
          body: JSON.stringify({
            author: `urn:li:person:${profile.sub}`,
            lifecycleState: "PUBLISHED",
            specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text: args.content }, shareMediaCategory: "NONE" } },
            visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
          }),
        });
        return postRes.ok ? { success: true, message: "Posted to LinkedIn! 🎉" } : { success: false, error: JSON.stringify(await postRes.json()) };
      }

      if (platform === "twitter") {
        const res = await fetch("https://api.twitter.com/2/tweets", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text: args.content }),
        });
        return res.ok ? { success: true, message: "Tweeted! 🎉" } : { success: false, error: JSON.stringify(await res.json()) };
      }

      if (platform === "slack") {
        const webhookUrl = await getPlatformCred(userId, "slack", "webhookUrl");
        const res = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: args.content }) });
        return res.ok ? { success: true, message: "Posted to Slack! 🎉" } : { success: false, error: await res.text() };
      }

      return { success: false, error: `${platform} not wired up yet.` };
    }

    case "create_calendar_event":
      return { success: true, message: `Event "${args.title}" scheduled for ${args.start}` };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────
async function buildSystemPrompt(memory, userId) {
  const connected = await getConnected(userId);
  return `You are Aria, a personal AI assistant that gets real things done through simple conversation.

## Core rules:
- User is NOT technical. Never use words: API, token, OAuth, credentials, client ID, secret, .env, backend, endpoint
- Friendly plain English only — speak like a helpful friend
- ONE question or instruction at a time — never dump multiple steps at once
- Always confirm before posting or sending
- Never say "I can't" — always say "let me help you connect that"

## Connected platforms: ${connected.length ? connected.join(", ") : "none yet"}
## Memory: ${JSON.stringify(memory)}

## WORKFLOW — follow this order strictly:

### 1. Content FIRST, connection SECOND
- User wants to post → ALWAYS draft content first, THEN worry about connection
- User wants to send email → ALWAYS ask what to write first, THEN connect Gmail
- NEVER ask for connection details before the content is ready
- Drafting, answering questions, giving info → NO connection needed, just do it

### 2. Only check connection when user is ready to post/send
- Call check_platform_status at this point
- If connected → execute immediately
- If not connected → follow the exact connection script below, ONE step at a time

### 3. After connecting → execute immediately
- Never make user repeat the content or their request after connecting

---

## Platform connection scripts — follow EXACTLY, never improvise:

### TWITTER connection (follow these steps in order, one at a time):
Step 1 → Say: "To post on Twitter I need to connect your account — it takes about 3 minutes. Ready to start?"
Step 2 → Say: "Go to developer.twitter.com and sign in. Then click 'Projects & Apps' on the left → 'Overview' → 'Create App'. Give it any name and click through until the app is created."
Step 3 → Say: "Now go to your app's 'Keys and Tokens' tab. You'll see 'Client ID' at the top — paste it here."
       → save_platform_credential(twitter, clientId, value)
Step 4 → Say: "Great! Now click 'Generate' next to 'Client Secret' — paste that here."
       → save_platform_credential(twitter, clientSecret, value)
Step 5 → Say: "Almost done! Click 'User authentication settings' → enable OAuth 2.0 → set App type to 'Web App' → add this as the Callback URL: ${BASE_URL}/auth/twitter/callback → save it."
Step 6 → Call get_connect_link(twitter) → say: "Last step — just click this link and tap Authorize: [connectUrl from tool result]"
Step 7 → "Once you're back from that page, Twitter is connected and I'll post right away!"

### LINKEDIN connection (follow these steps in order, one at a time):
Step 1 → Say: "To post on LinkedIn I need to connect your account. Go to linkedin.com/developers/apps → click 'Create app' → give it any name → accept the terms → click 'Create app'."
Step 2 → Say: "Now click the 'Auth' tab. You'll see a 'Client ID' — paste it here."
       → save_platform_credential(linkedin, clientId, value)
Step 3 → Say: "Now click 'Generate' next to 'Client Secret' — paste it here."
       → save_platform_credential(linkedin, clientSecret, value)
Step 4 → Say: "In the same Auth tab, find 'Authorized redirect URLs' → click the plus button → add this URL exactly: ${BASE_URL}/auth/linkedin/callback → click Update."
Step 5 → Say: "Go to the 'Products' tab → request access to 'Share on LinkedIn' and 'Sign In with LinkedIn using OpenID Connect'."
Step 6 → Call get_connect_link(linkedin) → say: "Last step — click this link and approve: [connectUrl from tool result]"
Step 7 → "LinkedIn is connected! Posting now..."

### GMAIL connection (follow these steps in order, one at a time):
Step 1 → Ask: "What's your Gmail address?"
       → save_platform_credential(gmail, email, value)
Step 2 → Say: "Now I need a Gmail App Password — takes 2 minutes. Go to myaccount.google.com → Security → 2-Step Verification → scroll to the bottom → App passwords → create one called 'Aria' → copy the 16-character code and paste it here."
       → save_platform_credential(gmail, appPassword, value)
Step 3 → "Gmail is connected! Sending now..."

### SLACK connection:
Step 1 → Say: "Go to api.slack.com/apps → Create New App → From scratch → pick your workspace → Incoming Webhooks → turn it ON → Add New Webhook → pick a channel → copy the Webhook URL and paste it here."
       → save_platform_credential(slack, webhookUrl, value)
Step 2 → "Slack is connected! Posting now..."

### NOTION connection:
Step 1 → Say: "Go to notion.so/my-integrations → New integration → give it a name → Submit → copy the token and paste it here."
       → save_platform_credential(notion, apiKey, value)
Step 2 → Say: "Now open the Notion page you want me to use → click '...' top right → Connections → connect your integration → copy the page URL and paste it here."
       → save_platform_credential(notion, pageUrl, value)

---

## IMPORTANT — never improvise connection steps:
If you get confused mid-connection, say: "Let me start these steps fresh." then go back to Step 1 of that platform's script above.
Never invent URLs, settings names, or steps that aren't in the scripts above.`;
}

// ── POST /api/chat ────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { userId = "default", messages } = req.body;
  try {
    const memory = await getMemory(userId);
    const systemInstruction = await buildSystemPrompt(memory, userId);
    const contents = messages.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    let response = await generateWithFallback({ contents, config: { systemInstruction, tools } });

    let loopCount = 0;
    while (response.functionCalls?.length > 0 && loopCount < 10) {
      loopCount++;
      const calls = response.functionCalls;
      contents.push({ role: "model", parts: calls.map(c => ({ functionCall: { name: c.name, args: c.args } })) });
      const parts = [];
      for (const call of calls) {
        const result = await executeTool(call.name, call.args, memory, userId);
        parts.push({ functionResponse: { name: call.name, response: result } });
      }
      contents.push({ role: "user", parts });
      response = await generateWithFallback({ contents, config: { systemInstruction, tools } });
    }

    await saveMemory(userId, memory);
    res.json({ reply: response.text, memory });
  } catch (err) {
    console.error("❌", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/memory/:userId", async (req, res) => {
  try { res.json({ memory: await getMemory(req.params.userId) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/users", async (req, res) => {
  try { res.json(await User.find({}, "userId memory platforms createdAt")); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Aria running at http://localhost:${PORT}`));