import fs from "fs";
import express from "express";
import Client from "ssh2-sftp-client";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import https from "https";

const app = express();
const PORT = process.env.PORT || 10000;
const BACKUP_DIR = "/tmp/backups";
const LOG_PATH = "/tmp/bridge.log";

function logLine(line) {
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${line}\n`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, text); } catch {}
}

// ==========================================
// 🔥 WEBHOOK → stuurt naar jouw MVC-site
// ==========================================
async function sendStatusWebhook(type, data) {
  const url = process.env.MAIL_WEBHOOK_URL;

  if (!url) {
    logLine("⚠ MAIL_WEBHOOK_URL niet ingesteld");
    return;
  }

  try {
    await axios.post(url, {
      type,
      filename: data.filename || null,
      sizeBytes: data.sizeBytes || null,
      sha1: data.sha1 || null,
      error: data.error || null,
      time: new Date().toISOString()
    }, {
      timeout: 10000,
      headers: { "Content-Type": "application/json" }
    });

    logLine("✉ Webhook mailstatus verzonden: " + type);
  } catch (e) {
    logLine("⚠ Webhook fout: " + e.message);
  }
}

function dumpAllEnv() {
  const keys = Object.keys(process.env).sort();
  logLine("=== BEGIN COMPLETE ENV DUMP ===");
  for (const k of keys) {
    const v = /PASS|SECRET|TOKEN/i.test(k)
      ? "(ingesteld)"
      : (process.env[k] || "LEEG");
    logLine(`${k} = ${v}`);
  }
  logLine("=== END ENV DUMP ===");
}

// ==========================================
// Test Webhook
// ==========================================
app.get("/testmail", async (req, res) => {
  try {
    await sendStatusWebhook("TEST", {});
    res.send("✔ Webhook-test verzonden!");
  } catch {
    res.status(500).send("❌ Webhook-test mislukt");
  }
});

app.get("/", (req, res) => res.send("✅ MonsterASP → Synology NAS Bridge actief"));

app.get("/logs", (req, res) => {
  try {
    const data = fs.readFileSync(LOG_PATH, "utf8");
    res.type("text/plain").send(data.slice(-15000));
  } catch {
    res.type("text/plain").send("Nog geen logbestand of geen schrijfrechten.");
  }
});

// ==========================================
// /RUN — hoofdjob
// ==========================================
app.get("/run", async (req, res) => {
  const sftp = new Client();

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    logLine("===== /run gestart =====");
    dumpAllEnv();

    // --- 1️⃣ Download via SFTP ---
    await sftp.connect({
      host: "bh2.siteasp.net",
      port: 22,
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASS,
    });

    const files = (await sftp.list("/")).filter(f => f.name.endsWith(".zpaq"));
    if (!files.length) throw new Error("Geen .zpaq-bestanden gevonden");

    files.sort((a, b) => b.modifyTime - a.modifyTime);
    const latest = files[0];

    const localPath = path.join(BACKUP_DIR, latest.name);

    logLine("Start download: " + latest.name);
    await sftp.fastGet("/" + latest.name, localPath);
    await sftp.end();

    const stats = fs.statSync(localPath);
    const sha1 = crypto.createHash("sha1").update(fs.readFileSync(localPath)).digest("hex");
    logLine(`✔ Download klaar (${stats.size} bytes, SHA1=${sha1})`);

    // --- 2️⃣ Maak unieke NAS-bestandsnaam ---
    const now = new Date();
    const stamp =
      now.getFullYear() +
      "-" + String(now.getMonth() + 1).padStart(2, "0") +
      "-" + String(now.getDate()).padStart(2, "0") +
      "_" + String(now.getHours()).padStart(2, "0") +
      "-" + String(now.getMinutes()).padStart(2, "0") +
      "-" + String(now.getSeconds()).padStart(2, "0");

    const ext = path.extname(latest.name);
    const baseName = path.basename(latest.name, ext);

    const uniqueFileName = `${baseName}_${stamp}${ext}`;

    logLine("NAS-bestandsnaam: " + uniqueFileName);

    // --- 3️⃣ Upload naar NAS ---
    const NAS_URL = process.env.NAS_URL;
    const NAS_USER = process.env.NAS_USER;
    const NAS_PASS = process.env.NAS_PASS;

    if (!NAS_URL || !NAS_USER || !NAS_PASS) {
      throw new Error("NAS_URL of NAS_USER of NAS_PASS ontbreekt");
    }

    let base = NAS_URL.trim();
    if (base.endsWith("/")) base = base.slice(0, -1);

    const webdavUrl = `${base}/${uniqueFileName}`;

    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    const response = await axios.put(webdavUrl, fs.createReadStream(localPath), {
      httpsAgent,
      maxBodyLength: Infinity,
      headers: { "Content-Type": "application/octet-stream" },
      auth: { username: NAS_USER, password: NAS_PASS },
      validateStatus: () => true,
    });

    if (!(response.status >= 200 && response.status < 300)) {
      throw new Error(`Upload mislukt (${response.status})`);
    }

    logLine("✔ Upload naar NAS voltooid");

    // --- 4️⃣ Cleanup: hou enkel 3 meest recente ---
    try {
      const propfind = await axios.request({
        url: base + "/",
        method: "PROPFIND",
        auth: { username: NAS_USER, password: NAS_PASS },
        httpsAgent,
        headers: { Depth: 1, "Content-Type": "text/xml" },
        validateStatus: () => true,
      });

      const xml = propfind.data;

      const entries = [...xml.matchAll(/<d:response>[\s\S]*?<d:href>(.*?)<\/d:href>[\s\S]*?<d:getlastmodified>(.*?)<\/d:getlastmodified>/g)]
        .map(m => ({
          name: decodeURIComponent(m[1]).split("/").pop(),
          modified: new Date(m[2])
        }))
        .filter(x => x.name.endsWith(".zpaq"))
        .sort((a, b) => b.modified - a.modified);

      if (entries.length > 3) {
        const toDelete = entries.slice(3);

        for (const f of toDelete) {
          logLine("Verwijder NAS-bestand: " + f.name);
          await axios.delete(`${base}/${f.name}`, {
            auth: { username: NAS_USER, password: NAS_PASS },
            httpsAgent,
            validateStatus: () => true,
          });
        }
      }

    } catch (cleanupErr) {
      logLine("⚠ Cleanup fout: " + cleanupErr.message);
    }

    // --- 5️⃣ Webhook-melding ---
    await sendStatusWebhook("OK", {
      filename: uniqueFileName,
      sizeBytes: stats.size,
      sha1
    });

    res.json({
      success: true,
      filename: uniqueFileName,
      sizeBytes: stats.size,
      sha1,
      nasUrl: webdavUrl,
      responseStatus: response.status,
    });

  } catch (err) {
    logLine("❌ Fout in /run: " + err.message);

    await sendStatusWebhook("ERR", { error: err.message });

    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => logLine(`Server running on port ${PORT}`));
