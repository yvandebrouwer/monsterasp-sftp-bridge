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

// 🧩 Nieuw: toon alle environment-variabelen die Node werkelijk ziet
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
    dumpAllEnv(); // <--- voeg deze regel toe

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

    logLine(`NAS_URL=${NAS_URL || "LEEG"}`);
    logLine(`NAS_USER=${NAS_USER ? "(ingesteld)" : "LEEG"}`);
    logLine(`NAS_PASS=${NAS_PASS ? "(ingesteld)" : "LEEG"}`);

    if (!NAS_URL || !NAS_USER || !NAS_PASS) {
      throw new Error("NAS_URL of NAS_USER of NAS_PASS ontbreekt");
    }

    // --- 2️⃣ Upload naar NAS via WebDAV ---
    let base = process.env.NAS_URL.trim();
    if (base.endsWith('/')) base = base.slice(0, -1);
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

    if (response.status >= 200 && response.status < 300) {
      logLine(`✔ Upload naar NAS voltooid (status ${response.status})`);
      res.json({
        status: "OK",
        filename: latest.name,
        sizeBytes: stats.size,
        sha1,
        nasUrl: webdavUrl,
        responseStatus: response.status,
      });
    } else {
      throw new Error(`Upload mislukt (${response.status})`);
    }
  } catch (err) {
    logLine("❌ Fout in /run: " + err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

app.listen(PORT, () => logLine(`Server running on port ${PORT}`));

