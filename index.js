import express from "express";
import Client from "ssh2-sftp-client";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import https from "https";

const app = express();
const PORT = process.env.PORT || 10000;
const BACKUP_DIR = "/tmp/backups";
const LOG_PATH = "/tmp/bridge.log";

// ---------------------------
// LOGFUNCTIE
// ---------------------------
function logLine(line) {
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${line}\n`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, text); } catch {}
}

// ---------------------------
// ALGEMENE INSTELLINGEN
// ---------------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-Backup-Date");
  next();
});

// ---------------------------
// LOGS BEKIJKEN
// ---------------------------
app.get("/logs", (req, res) => {
  try {
    const data = fs.readFileSync(LOG_PATH, "utf8");
    res.type("text/plain").send(data.slice(-8000));
  } catch {
    res.type("text/plain").send("Nog geen logbestand of geen schrijfrechten.");
  }
});

app.get("/", (req, res) => res.send("✅ MonsterASP → Synology NAS Bridge actief"));

// ---------------------------
// /RUN → DOWNLOAD EN UPLOAD
// ---------------------------
app.get("/run", async (req, res) => {
  const sftp = new Client();

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    logLine("===== /run gestart =====");

    // 1️⃣ Download laatste .zpaq via SFTP
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

    // 2️⃣ Upload naar NAS via WebDAV
    logLine("ENV NAS_URL=" + JSON.stringify(process.env.NAS_URL));
    logLine("ENV NAS_USER=" + JSON.stringify(process.env.NAS_USER));
    logLine("ENV NAS_PASS=" + (process.env.NAS_PASS ? "(ingesteld)" : "LEEG"));

    const nasUrlBase = process.env.NAS_URL;
    if (!nasUrlBase || !nasUrlBase.startsWith("http")) {
      throw new Error("NAS_URL ongeldig of niet ingesteld");
    }

    const webdavUrl = `${nasUrlBase}${encodeURIComponent(latest.name)}`;
    logLine(`Upload naar NAS: ${webdavUrl}`);

    // SSL-validatie uitschakelen (self-signed certificaten toestaan)
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    const response = await axios.put(webdavUrl, fs.createReadStream(localPath), {
      httpsAgent,
      maxBodyLength: Infinity,
      headers: { "Content-Type": "application/octet-stream" },
      auth: {
        username: process.env.NAS_USER,
        password: process.env.NAS_PASS,
      },
      validateStatus: () => true
    });

    if (response.status >= 200 && response.status < 300) {
      logLine("✔ Upload naar NAS voltooid");
      res.json({
        status: "OK",
        filename: latest.name,
        sizeBytes: stats.size,
        sha1,
        nasUrl: webdavUrl,
        responseStatus: response.status
      });
    } else {
      throw new Error(`Upload mislukt (${response.status})`);
    }

  } catch (err) {
    logLine("❌ Fout in /run: " + err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

// ---------------------------
// SERVER START
// ---------------------------
app.listen(PORT, () => logLine(`Server running on port ${PORT}`));
