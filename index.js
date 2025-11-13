import fs from "fs";
import express from "express";
import Client from "ssh2-sftp-client";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import https from "https";
import nodemailer from "nodemailer";

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

// Sexy HTML mail versturen
async function sendSexyMail(type, data) {
  let subject;
  let html;

  if (type === "OK") {
    subject = "✓ Backup Succesvol — Bridge OK";

    html = `
      <div style="font-family:Arial;padding:20px;background:#f6fff6;border:1px solid #c8e6c9;border-radius:8px;">
        <h2 style="color:#2e7d32;">✔ Backup succesvol!</h2>
        <p>De nieuwste backup werd correct gedownload én opgeslagen op de NAS.</p>

        <table style="margin-top:15px;">
          <tr><td><strong>Bestand:</strong></td><td>${data.filename}</td></tr>
          <tr><td><strong>Grootte:</strong></td><td>${data.sizeBytes} bytes</td></tr>
          <tr><td><strong>SHA1:</strong></td><td>${data.sha1}</td></tr>
          <tr><td><strong>Tijdstip:</strong></td><td>${new Date().toLocaleString()}</td></tr>
        </table>

        <p style="margin-top:20px;color:#555;">
          Alles werkt zoals het hoort. ✔<br>
          — Bridge Service
        </p>
      </div>
    `;
  }

  if (type === "ERR") {
    subject = "⚠ Backup Mislukt — Bridge FOUT";

    html = `
      <div style="font-family:Arial;padding:20px;background:#fff5f5;border:1px solid #ffcdd2;border-radius:8px;">
        <h2 style="color:#c62828;">❌ Er is een fout opgetreden!</h2>
        <p>De bridge kon de backup niet correct verwerken.</p>

        <p style="font-size:14px;margin-top:15px;">
          <strong>Foutmelding:</strong><br>
          <span style="color:#b71c1c;">${data.error}</span>
        </p>

        <p style="margin-top:20px;color:#555;">
          Gelieve dit na te kijken op de server of NAS.<br>
          — Bridge Service
        </p>
      </div>
    `;
  }

  try {
    const t = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
    });

    await t.sendMail({
      from: process.env.GMAIL_USER,
      to: "debrouweryvan@gmail.com",
      subject,
      html
    });

    logLine("✉ Sexy mail verzonden: " + subject);
  } catch (e) {
    logLine("⚠ Mailfout: " + e.message);
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

app.get("/", (req, res) => res.send("✅ MonsterASP → Synology NAS Bridge actief"));

app.get("/logs", (req, res) => {
  try {
    const data = fs.readFileSync(LOG_PATH, "utf8");
    res.type("text/plain").send(data.slice(-15000));
  } catch {
    res.type("text/plain").send("Nog geen logbestand of geen schrijfrechten.");
  }
});

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

    // --- 2️⃣ Upload naar NAS via WebDAV ---
    const NAS_URL = process.env.NAS_URL;
    const NAS_USER = process.env.NAS_USER;
    const NAS_PASS = process.env.NAS_PASS;

    if (!NAS_URL || !NAS_USER || !NAS_PASS) {
      throw new Error("NAS_URL of NAS_USER of NAS_PASS ontbreekt");
    }

    let base = NAS_URL.trim();
    if (base.endsWith("/")) base = base.slice(0, -1);
    const webdavUrl = `${base}/${latest.name}`;

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

    // --- 3️⃣ Cleanup op NAS: hou alleen 3 recentste ---
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
      const matches = [...xml.matchAll(/<d:href>(.*?)<\/d:href>/g)];

      let entries = matches
        .map(m => decodeURIComponent(m[1]))
        .filter(x => x.endsWith(".zpaq"))
        .map(x => x.split("/").pop());

      if (entries.length > 3) {
        entries.sort(); // oudste eerst
        const toDelete = entries.slice(0, entries.length - 3);

        for (const f of toDelete) {
          logLine("Verwijder NAS-bestand: " + f);
          await axios.delete(`${base}/${f}`, {
            auth: { username: NAS_USER, password: NAS_PASS },
            httpsAgent,
            validateStatus: () => true,
          });
        }
      }
    } catch (cleanupErr) {
      logLine("⚠ Cleanup fout: " + cleanupErr.message);
    }

    // --- verstuur sexy succesmail ---
    await sendSexyMail("OK", {
      filename: latest.name,
      sizeBytes: stats.size,
      sha1
    });

    res.json({
      status: "OK",
      filename: latest.name,
      sizeBytes: stats.size,
      sha1,
      nasUrl: webdavUrl,
      responseStatus: response.status,
    });

  } catch (err) {
    logLine("❌ Fout in /run: " + err.message);

    await sendSexyMail("ERR", { error: err.message });

    res.status(500).json({ status: "Error", error: err.message });
  }
});

app.listen(PORT, () => logLine(`Server running on port ${PORT}`));
