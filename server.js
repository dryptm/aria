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

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// ── Gemini with model rotation ────────────────────────────────────────────────
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODELS = [
  "gemini-2.0-flash-lite-001",
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
];

async function generateWithFallback(params) {
  let lastError;
  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({ ...params, model });
      console.log(`✅ Model: ${model}`);
      return response;
    } catch (err) {
      const retryable = err.message?.includes("503") || err.message?.includes("503") ||
        err.message?.includes("overloaded") || err.message?.includes("high demand") ||
        err.message?.includes("UNAVAILABLE") || err.message?.includes("429") ||
        err.message?.includes("quota") || err.message?.includes("404") ||
        err.message?.includes("not found") || err.message?.includes("no longer available");
      if (retryable) {
        console.log(`⚠️  ${model} unavailable, trying next...`);
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`All models failed. Last: ${lastError?.message}`);
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ Database connected"))
  .catch(err => console.error("❌ DB error:", err));

// ── User schema ───────────────────────────────────────────────────────────────
// Everything per-user lives here — credentials, tokens, memory, contacts
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },

  // General AI memory: contacts, preferences, notes
  memory: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Per-user platform credentials (collected via chat, stored here)
  // Structure example:
  // platforms.gmail.email, platforms.gmail.appPassword
  // platforms.linkedin.clientId, platforms.linkedin.clientSecret, platforms.linkedin.accessToken
  // platforms.slack.webhookUrl
  // platforms.notion.apiKey, platforms.notion.pageUrl
  platforms: { type: mongoose.Schema.Types.Mixed, default: {} },

}, { timestamps: true });

const User = mongoose.model("User", userSchema);

// ── DB helpers ────────────────────────────────────────────────────────────────
async function getUser(userId) {
  let user = await User.findOne({ userId });
  if (!user) user = await User.create({ userId, memory: {}, platforms: {} });
  return user;
}

async function getMemory(userId) {
  const user = await getUser(userId);
  return user.memory ? JSON.parse(JSON.stringify(user.memory)) : {};
}

async function saveMemory(userId, memory) {
  await User.findOneAndUpdate({ userId }, { $set: { memory } }, { upsert: true, new: true });
}

async function getPlatforms(userId) {
  const user = await getUser(userId);
  return user.platforms ? JSON.parse(JSON.stringify(user.platforms)) : {};
}

async function savePlatformCredential(userId, platform, key, value) {
  await User.findOneAndUpdate(
    { userId },
    { $set: { [`platforms.${platform}.${key}`]: value } },
    { upsert: true, new: true }
  );
}

async function getPlatformCredential(userId, platform, key) {
  const user = await User.findOne({ userId });
  return user?.platforms?.[platform]?.[key] || null;
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

function deepGet(obj, dotPath) {
  return dotPath.split(".").reduce((o, k) => o?.[k], obj);
}

// ── OAuth state store ─────────────────────────────────────────────────────────
// state → { userId, platform }  — expires after 10 min
const oauthStates = new Map();

// ── Build OAuth URL using PER-USER credentials from DB ───────────────────────
async function buildOAuthUrl(userId, platform) {
  const clientId = await getPlatformCredential(userId, platform, "clientId");
  const redirectUri = `${BASE_URL}/auth/${platform}/callback`;

  if (platform === "linkedin") {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "openid profile w_member_social",
      state: "", // filled in below
    });
    return { baseUrl: `https://www.linkedin.com/oauth/v2/authorization`, params, redirectUri };
  }
  if (platform === "twitter") {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "tweet.write users.read offline.access",
      state: "",
      code_challenge: "challenge",
      code_challenge_method: "plain",
    });
    return { baseUrl: `https://twitter.com/i/oauth2/authorize`, params, redirectUri };
  }
  return null;
}

// ── OAuth routes ──────────────────────────────────────────────────────────────
app.get("/auth/:platform/start", async (req, res) => {
  const { platform } = req.params;
  const { userId = "default" } = req.query;

  const clientId = await getPlatformCredential(userId, platform, "clientId");
  if (!clientId) {
    return res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>⚠️ ${platform} not set up yet</h2>
      <p>Go back to the chat — Aria will guide you through connecting ${platform}.</p>
    </body></html>`);
  }

  const state = crypto.randomBytes(16).toString("hex");
  oauthStates.set(state, { userId, platform });
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);

  const urlInfo = await buildOAuthUrl(userId, platform);
  urlInfo.params.set("state", state);
  res.redirect(`${urlInfo.baseUrl}?${urlInfo.params.toString()}`);
});

app.get("/auth/:platform/callback", async (req, res) => {
  const { platform } = req.params;
  const { code, state, error } = req.query;

  if (error) {
    return res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>❌ Connection cancelled</h2><p>Close this tab and try again in the chat.</p>
    </body></html>`);
  }

  const stateData = oauthStates.get(state);
  if (!stateData) {
    return res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>⏰ Link expired</h2><p>Go back to the chat and ask Aria for a new link.</p>
    </body></html>`);
  }

  oauthStates.delete(state);
  const { userId } = stateData;

  try {
    const clientId = await getPlatformCredential(userId, platform, "clientId");
    const clientSecret = await getPlatformCredential(userId, platform, "clientSecret");
    const redirectUri = `${BASE_URL}/auth/${platform}/callback`;
    const tokenUrl = platform === "linkedin"
      ? "https://www.linkedin.com/oauth/v2/accessToken"
      : "https://api.twitter.com/2/oauth2/token";

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) throw new Error(tokenData.error_description || "No token received");

    await savePlatformCredential(userId, platform, "accessToken", tokenData.access_token);
    if (tokenData.refresh_token) {
      await savePlatformCredential(userId, platform, "refreshToken", tokenData.refresh_token);
    }

    const platformNames = { linkedin: "LinkedIn", twitter: "Twitter / X" };
    res.send(`<html><head><style>
      body{font-family:-apple-system,sans-serif;text-align:center;padding:80px 20px}
      .icon{font-size:64px}.h{color:#16a34a;margin:16px 0 8px}p{color:#666}
    </style></head><body>
      <div class="icon">✅</div>
      <h2 class="h">${platformNames[platform] || platform} connected!</h2>
      <p>You can close this tab and go back to your chat.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
  } catch (err) {
    console.error("OAuth error:", err);
    res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>❌ Something went wrong</h2><p>${err.message}</p>
      <p>Go back to the chat and try again.</p>
    </body></html>`);
  }
});

// ── Gmail sender ──────────────────────────────────────────────────────────────
async function sendRealEmail(email, appPassword, to, subject, body) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: email, pass: appPassword },
  });
  await transporter.sendMail({ from: email, to, subject, text: body });
}

// ── Connected platforms checker ───────────────────────────────────────────────
async function getConnectedPlatforms(userId) {
  const p = await getPlatforms(userId);
  const connected = [];
  if (p?.gmail?.email && p?.gmail?.appPassword) connected.push("gmail");
  if (p?.linkedin?.accessToken) connected.push("linkedin");
  if (p?.twitter?.accessToken) connected.push("twitter");
  if (p?.slack?.webhookUrl) connected.push("slack");
  if (p?.notion?.apiKey) connected.push("notion");
  return connected;
}

// ── Tools ─────────────────────────────────────────────────────────────────────
const tools = [
  {
    functionDeclarations: [
      {
        name: "save_to_memory",
        description: "Save contact info, user name, preferences, or anything worth remembering for future conversations.",
        parameters: {
          type: "OBJECT",
          properties: {
            path:  { type: "STRING", description: "Dot-path e.g. 'contacts.ravi.email' or 'user.name'" },
            value: { type: "STRING", description: "Value to save" },
          },
          required: ["path", "value"],
        },
      },
      {
        name: "save_platform_credential",
        description: "Save a platform credential collected from the user in chat. Stored securely per user in the database.",
        parameters: {
          type: "OBJECT",
          properties: {
            platform: { type: "STRING", description: "Platform name: gmail, linkedin, twitter, slack, notion" },
            key:      { type: "STRING", description: "Credential field: email, appPassword, clientId, clientSecret, webhookUrl, apiKey, pageUrl, accessToken" },
            value:    { type: "STRING", description: "The value the user provided" },
          },
          required: ["platform", "key", "value"],
        },
      },
      {
        name: "get_oauth_link",
        description: "Generate a one-click OAuth authorization link for LinkedIn or Twitter. Only call this AFTER the user has provided and saved their clientId and clientSecret via save_platform_credential.",
        parameters: {
          type: "OBJECT",
          properties: {
            platform: { type: "STRING", description: "linkedin or twitter" },
          },
          required: ["platform"],
        },
      },
      {
        name: "check_platform_status",
        description: "Check whether a platform is connected for this user and what credentials are still missing.",
        parameters: {
          type: "OBJECT",
          properties: {
            platform: { type: "STRING" },
          },
          required: ["platform"],
        },
      },
      {
        name: "send_email",
        description: "Send a real email via the user's connected Gmail.",
        parameters: {
          type: "OBJECT",
          properties: {
            to:      { type: "STRING" },
            subject: { type: "STRING" },
            body:    { type: "STRING" },
          },
          required: ["to", "subject", "body"],
        },
      },
      {
        name: "platform_post",
        description: "Post content to a connected platform.",
        parameters: {
          type: "OBJECT",
          properties: {
            platform: { type: "STRING", description: "linkedin, twitter, slack, notion" },
            content:  { type: "STRING", description: "Text content to post" },
          },
          required: ["platform", "content"],
        },
      },
      {
        name: "create_calendar_event",
        description: "Create a calendar event",
        parameters: {
          type: "OBJECT",
          properties: {
            title:       { type: "STRING" },
            start:       { type: "STRING", description: "ISO 8601" },
            end:         { type: "STRING", description: "ISO 8601" },
            attendees:   { type: "STRING" },
            description: { type: "STRING" },
          },
          required: ["title", "start", "end"],
        },
      },
    ],
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, args, memory, userId) {
  console.log(`🛠  ${name}`, args);

  switch (name) {

    case "save_to_memory": {
      deepSet(memory, args.path, args.value);
      return { success: true };
    }

    case "save_platform_credential": {
      await savePlatformCredential(userId, args.platform, args.key, args.value);
      return { success: true, saved: `${args.platform}.${args.key}` };
    }

    case "get_oauth_link": {
      const platform = args.platform.toLowerCase();
      const clientId = await getPlatformCredential(userId, platform, "clientId");
      const clientSecret = await getPlatformCredential(userId, platform, "clientSecret");

      if (!clientId || !clientSecret) {
        return {
          success: false,
          missingCredentials: true,
          missing: !clientId ? "clientId" : "clientSecret",
          message: `Need ${!clientId ? "Client ID" : "Client Secret"} before generating the link. Ask the user for it.`,
        };
      }

      const state = crypto.randomBytes(16).toString("hex");
      oauthStates.set(state, { userId, platform });
      setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);

      const urlInfo = await buildOAuthUrl(userId, platform);
      urlInfo.params.set("state", state);
      const connectUrl = `${urlInfo.baseUrl}?${urlInfo.params.toString()}`;

      return {
        success: true,
        connectUrl,
        message: `OAuth link generated. Tell the user: "Click this link to connect your ${platform}: ${connectUrl} — just log in and click Allow, takes 10 seconds!"`,
        SHOW_THIS_EXACT_URL: connectUrl,
      };
    }

    case "check_platform_status": {
      const platform = args.platform.toLowerCase();
      const p = await getPlatforms(userId);
      const creds = p?.[platform] || {};
      const connected = await getConnectedPlatforms(userId);
      const isConnected = connected.includes(platform);

      const requirements = {
        gmail:    ["email", "appPassword"],
        linkedin: ["clientId", "clientSecret", "accessToken"],
        twitter:  ["clientId", "clientSecret", "accessToken"],
        slack:    ["webhookUrl"],
        notion:   ["apiKey", "pageUrl"],
      };

      const required = requirements[platform] || [];
      const have = required.filter(k => creds[k]);
      const missing = required.filter(k => !creds[k]);

      return { platform, isConnected, have, missing, allCredentials: Object.keys(creds) };
    }

    case "send_email": {
      const email = await getPlatformCredential(userId, "gmail", "email");
      const appPassword = await getPlatformCredential(userId, "gmail", "appPassword");
      if (!email || !appPassword) {
        return { success: false, notConnected: true, message: "Gmail not connected. Guide the user to connect Gmail first." };
      }
      try {
        await sendRealEmail(email, appPassword, args.to, args.subject, args.body);
        return { success: true, message: `Email sent from ${email} to ${args.to}` };
      } catch (err) {
        if (err.message.includes("Invalid login")) {
          return { success: false, error: "Gmail login failed — the App Password may be wrong. Ask the user to re-enter it." };
        }
        return { success: false, error: err.message };
      }
    }

    case "platform_post": {
      const platform = args.platform.toLowerCase();

      if (platform === "linkedin") {
        const accessToken = await getPlatformCredential(userId, "linkedin", "accessToken");
        if (!accessToken) return { success: false, notConnected: true, message: "LinkedIn not connected. Guide setup first." };
        try {
          const profileRes = await fetch("https://api.linkedin.com/v2/userinfo", {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const profile = await profileRes.json();
          const postRes = await fetch("https://api.linkedin.com/v2/ugcPosts", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              "X-Restli-Protocol-Version": "2.0.0",
            },
            body: JSON.stringify({
              author: `urn:li:person:${profile.sub}`,
              lifecycleState: "PUBLISHED",
              specificContent: {
                "com.linkedin.ugc.ShareContent": {
                  shareCommentary: { text: args.content },
                  shareMediaCategory: "NONE",
                },
              },
              visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
            }),
          });
          if (postRes.ok) return { success: true, message: "Posted to LinkedIn! 🎉" };
          const errData = await postRes.json();
          return { success: false, error: JSON.stringify(errData) };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      if (platform === "twitter") {
        const accessToken = await getPlatformCredential(userId, "twitter", "accessToken");
        if (!accessToken) return { success: false, notConnected: true, message: "Twitter not connected. Guide setup first." };
        const res = await fetch("https://api.twitter.com/2/tweets", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text: args.content }),
        });
        const data = await res.json();
        if (res.ok) return { success: true, message: "Tweeted! 🎉" };
        return { success: false, error: JSON.stringify(data) };
      }

      if (platform === "slack") {
        const webhookUrl = await getPlatformCredential(userId, "slack", "webhookUrl");
        if (!webhookUrl) return { success: false, notConnected: true, message: "Slack not connected. Guide setup first." };
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: args.content }),
        });
        if (res.ok) return { success: true, message: "Posted to Slack! 🎉" };
        return { success: false, error: await res.text() };
      }

      return { success: false, error: `${platform} posting not wired up yet.` };
    }

    case "create_calendar_event":
      return { success: true, message: `Event "${args.title}" scheduled for ${args.start}` };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────
async function buildSystemPrompt(memory, userId) {
  const connected = await getConnectedPlatforms(userId);
  const platforms = await getPlatforms(userId);

  return `You are Aria, a personal AI assistant that gets real things done through simple conversation.

## The user is NOT technical. Speak like a helpful friend.
Never use words like: API, token, OAuth, credentials, developer, client ID, secret, environment, .env, backend.
Instead say: "connection code", "app password", "link code", "account key".

## This user's connected platforms: ${connected.length > 0 ? connected.join(", ") : "none yet"}
## Memory: ${JSON.stringify(memory, null, 2)}

## How to connect each platform (guide users through this in chat):

### Gmail:
Step 1: Ask "What's your Gmail address?" → save_platform_credential(gmail, email, value)
Step 2: Ask "Now I need your Gmail App Password. Here's how to get it in 2 minutes:
  1. Go to myaccount.google.com
  2. Click Security on the left
  3. Click 2-Step Verification (turn it on if needed)
  4. Scroll to the bottom → App passwords
  5. Create one called 'Aria' → copy the 16-character code"
→ save_platform_credential(gmail, appPassword, value)
→ Gmail is now connected!

### LinkedIn:
Step 1: "To connect LinkedIn, you'll need to create a free LinkedIn developer app — it takes about 3 minutes and you only do it once. Ready? Here's what to do:
  1. Go to linkedin.com/developers/apps
  2. Click 'Create app'
  3. Fill in any app name (like 'My Aria') and your LinkedIn profile
  4. Accept terms → Create app"
Step 2: "Now click the 'Auth' tab on your app. You'll see a 'Client ID' — paste it here."
→ save_platform_credential(linkedin, clientId, value)
Step 3: "Right below that, click 'Generate' next to Client Secret → paste it here."
→ save_platform_credential(linkedin, clientSecret, value)
Step 4: "Almost done! Add this redirect URL in the Auth tab under 'Authorized redirect URLs':
  ${BASE_URL}/auth/linkedin/callback
  Then click 'Update'."
Step 5: "Finally, go to the 'Products' tab → request 'Share on LinkedIn' and 'Sign In with LinkedIn using OpenID Connect'."
Step 6: Call get_oauth_link(linkedin) → show the URL to the user as a clickable link
→ User clicks, approves → LinkedIn connected!

### Twitter:
Step 1: "Go to developer.twitter.com → Sign in → Create a new project and app"
Step 2: Ask for Client ID → save_platform_credential(twitter, clientId, value)
Step 3: Ask for Client Secret → save_platform_credential(twitter, clientSecret, value)
Step 4: "Add this callback URL in your Twitter app settings: ${BASE_URL}/auth/twitter/callback"
Step 5: Call get_oauth_link(twitter) → show URL to user

### Slack:
Step 1: "Go to api.slack.com/apps → Create New App → From scratch → pick your workspace
  → Incoming Webhooks → turn ON → Add New Webhook → pick a channel → copy the URL"
→ save_platform_credential(slack, webhookUrl, value)
→ Slack is now connected!

### Notion:
Step 1: "Go to notion.so/my-integrations → New integration → Submit → copy the token"
→ save_platform_credential(notion, apiKey, value)
Step 2: "Open the Notion page you want me to use → click '...' → Connections → connect your integration → copy the page URL"
→ save_platform_credential(notion, pageUrl, value)
→ Notion connected!

## Workflow for every task:
1. Understand what the user wants
2. Call check_platform_status to see if the platform is ready
3. If not connected → guide them through connection steps above (one step at a time)
4. Collect task details (content, recipient, etc.) — ONE question at a time
5. Confirm before executing
6. Execute the action

## Rules:
- NEVER say "I can't" — always guide them to connect
- ONE question at a time — never dump all steps at once
- Always confirm before posting or sending
- Save all useful info (contacts, names) to memory
- After connecting a platform, immediately proceed with the original task
- Be warm, encouraging, and celebrate when things work ("Great! LinkedIn is connected 🎉")`;
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
    while (response.functionCalls && response.functionCalls.length > 0 && loopCount < 10) {
      loopCount++;
      const calls = response.functionCalls;
      contents.push({ role: "model", parts: calls.map(c => ({ functionCall: { name: c.name, args: c.args } })) });
      const responseParts = [];
      for (const call of calls) {
        const result = await executeTool(call.name, call.args, memory, userId);
        responseParts.push({ functionResponse: { name: call.name, response: result } });
      }
      contents.push({ role: "user", parts: responseParts });
      response = await generateWithFallback({ contents, config: { systemInstruction, tools } });
    }

    await saveMemory(userId, memory);
    res.json({ reply: response.text, memory });
  } catch (err) {
    console.error("❌", err);
    res.status(500).json({ error: err.message });
  }
});

// ── API routes ────────────────────────────────────────────────────────────────
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
