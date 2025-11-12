import express from "express";
import Client from "ssh2-sftp-client";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import https from "https";
import axios from "axios";

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

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-Backup-Date");
  next();
});

app.get("/logs", (req, res) => {
  try {
    const data = fs.readFileSync(LOG_PATH, "utf8");
    res.type("text/plain").send(data.slice(-8000));
  } catch {
    res.type("text/plain").send("Nog geen logbestand of geen schrijfrechten.");
  }
});

app.get("/", (req, res) => res.send("✅ MonsterASP SFTP Bridge actief"));

app.get("/run", async (req, res) => {
  const sftp = new Client();
  const remoteDir = "/";
  const agent = new https.Agent({ rejectUnauthorized: false }); // self-signed certs toelaten

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    logLine("===== /run gestart =====");

    await sftp.connect({
      host: "bh2.siteasp.net",
      port: 22,
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASS,
    });

    let files = (await sftp.list(remoteDir)).filter(f => f.name.endsWith(".zpaq"));
    if (!files.length) throw new Error("Geen .zpaq-bestanden gevonden");
    files.sort((a, b) => b.modifyTime - a.modifyTime);
    const latest = files[0];
    const remoteFile = `${remoteDir}/${latest.name}`;
    const localPath = path.join(BACKUP_DIR, latest.name);

    logLine("Download start: " + remoteFile);
    await sftp.fastGet(remoteFile, localPath, {
      concurrency: 1,
      chunkSize: 4 * 1024 * 1024,
      step: (transferred, chunk, total) => {
        if (transferred % (10 * 1024 * 1024) < 4 * 1024 * 1024) {
          logLine(`Progress: ${transferred}/${total} bytes`);
        }
      },
    });
    await sftp.end();

    const stats = fs.statSync(localPath);
    logLine(`✔ Download klaar (${stats.size} bytes)`);

    // SHA1
    const fileBuffer = fs.readFileSync(localPath);
    const sha1 = crypto.createHash("sha1").update(fileBuffer).digest("hex");
    logLine(`SHA1: ${sha1}`);

    // -----------------------------
    // UPLOAD NAAR NAS VIA WEBDAV
    // -----------------------------
    const nasUrlBase = process.env.NAS_URL;
    if (!nasUrlBase || !nasUrlBase.startsWith("http"))
      throw new Error("NAS_URL ongeldig of niet ingesteld");

    const uploadUrl = `${nasUrlBase}${encodeURIComponent(latest.name)}`;
    logLine("NAS upload URL = " + uploadUrl);

    const nasResp = await axios.put(uploadUrl, fs.createReadStream(localPath), {
      httpsAgent: agent,
      auth: { username: process.env.NAS_USER, password: process.env.NAS_PASS },
      headers: { "Content-Type": "application/octet-stream" },
      maxBodyLength: Infinity,
    });

    logLine(`✔ Upload voltooid, status ${nasResp.status}`);

    res.json({
      status: "OK",
      filename: latest.name,
      sizeBytes: stats.size,
      sha1: sha1,
      nasStatus: nasResp.status,
      nasUrl: uploadUrl
    });
  } catch (err) {
    logLine("❌ Fout in /run: " + err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

app.listen(PORT, () => logLine(`Server running on port ${PORT}`));
