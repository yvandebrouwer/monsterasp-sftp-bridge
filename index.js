import fs from "fs";
import express from "express";
import Client from "ssh2-sftp-client";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import https from "https";

/* ---------- ENV HELPERS (vangen rare KEY-namen met spaties etc.) ---------- */
function findEnvKey(target) {
  // Vind exacte match of dezelfde naam zonder spaties/CR/LF
  const keys = Object.keys(process.env);
  const norm = s => (s || "").replace(/\s|\r|\n/g, "");
  let k = keys.find(x => x === target) || keys.find(x => norm(x) === target);
  return k || null;
}
function getEnv(target) {
  const k = findEnvKey(target);
  return k ? process.env[k] : undefined;
}
function mask(v) {
  if (!v) return "LEEG";
  return "(ingesteld)";
}
function logEnvSnapshot() {
  const keys = Object.keys(process.env)
    .filter(k => /^(NAS|SFTP|PORT)/.test(k.replace(/\s/g, "")))  // toon alleen relevante
    .sort();

  const shown = keys.map(k => {
    const showValue =
      /PASS|SECRET|TOKEN/i.test(k) ? "(ingesteld)" : (process.env[k] || "LEEG");
    return `${JSON.stringify(k)} = ${showValue}`;
  });

  console.log("==== ENV SNAPSHOT (relevante keys) ====");
  for (const line of shown) console.log(line);
  console.log("=======================================");
}

/* ---------- App ---------- */
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

app.get("/", (req, res) => res.send("✅ MonsterASP → Synology NAS Bridge actief"));

app.get("/logs", (req, res) => {
  try {
    const data = fs.readFileSync(LOG_PATH, "utf8");
    res.type("text/plain").send(data.slice(-12000));
  } catch {
    res.type("text/plain").send("Nog geen logbestand of geen schrijfrechten.");
  }
});

app.get("/run", async (req, res) => {
  const sftp = new Client();
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    logLine("===== /run gestart =====");

    // 1) SFTP download
    const SFTP_USER = getEnv("SFTP_USER");
    const SFTP_PASS = getEnv("SFTP_PASS");

    logLine(`SFTP_USER=${SFTP_USER ? "(ingesteld)" : "LEEG"}`);
    if (!SFTP_USER || !SFTP_PASS) throw new Error("SFTP_USER/SFTP_PASS ontbreken");

    await sftp.connect({
      host: "bh2.siteasp.net",
      port: 22,
      username: SFTP_USER,
      password: SFTP_PASS,
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

    // 2) WebDAV upload naar NAS
    // Toon *alle* relevante env (voor diagnose)
    logEnvSnapshot();

    // Lees NAS-waarden via robuuste helper (vangt KEY-typos/spaties op)
    let NAS_URL  = getEnv("NAS_URL");
    let NAS_USER = getEnv("NAS_USER");
    let NAS_PASS = getEnv("NAS_PASS");

    logLine(`NAS_URL=${NAS_URL || "LEEG"}`);
    logLine(`NAS_USER=${NAS_USER ? "(ingesteld)" : "LEEG"}`);
    logLine(`NAS_PASS=${mask(NAS_PASS)}`);

    // Trim en normaliseer URL
    if (NAS_URL) NAS_URL = NAS_URL.trim();
    if (NAS_URL && !/^https?:\/\//i.test(NAS_URL)) {
      throw new Error(`NAS_URL lijkt ongeldig: ${NAS_URL}`);
    }
    // Zorg dat NAS_URL exact één trailing slash heeft
    if (NAS_URL && !NAS_URL.endsWith("/")) NAS_URL = NAS_URL + "/";

    if (!NAS_URL || !NAS_USER || !NAS_PASS) {
      throw new Error("NAS_URL of NAS_USER of NAS_PASS ontbreekt");
    }

    const webdavUrl = `${NAS_URL}${encodeURIComponent(latest.name)}`;
    logLine(`Upload naar NAS: ${webdavUrl}`);

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
