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

// ---------------------------------------------------------------
// LOG
// ---------------------------------------------------------------
function logLine(line) {
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${line}\n`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, text); } catch {}
}

// ---------------------------------------------------------------
// WEBHOOK
// ---------------------------------------------------------------
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

    logLine("✉ Webhook verzonden: " + type);

  } catch (e) {
    logLine("⚠ Webhook fout: " + e.message);
  }
}

// ---------------------------------------------------------------
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

// ---------------------------------------------------------------
app.get("/", (req, res) => res.send("✅ MonsterASP → Synology NAS Bridge actief"));

app.get("/testmail", async (req, res) => {
  await sendStatusWebhook("TEST", {});
  res.send("✔ Webhook-test verzonden!");
});

// ---------------------------------------------------------------
// RUN
// ---------------------------------------------------------------
app.get("/run", async (req, res) => {
  const sftp = new Client();

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    logLine("===== /run gestart =====");
    dumpAllEnv();

    //----------------------------------------------------------------
    // DOWNLOAD
    //----------------------------------------------------------------
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

    //----------------------------------------------------------------
    // NIEUWE BESTANDSNAAM
    //----------------------------------------------------------------
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").split(".")[0];
    const newName = `${latest.name.replace(".zpaq", "")}_${stamp}.zpaq`;

    //----------------------------------------------------------------
    // UPLOAD NAAR NAS
    //----------------------------------------------------------------
    const NAS_URL = process.env.NAS_URL;
    const NAS_USER = process.env.NAS_USER;
    const NAS_PASS = process.env.NAS_PASS;

    if (!NAS_URL || !NAS_USER || !NAS_PASS) {
      throw new Error("NAS_URL of NAS_USER of NAS_PASS ontbreekt");
    }

    let base = NAS_URL.trim().replace(/\/$/, "");
    const webdavUrl = `${base}/${newName}`;

    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    const response = await axios.put(webdavUrl, fs.createReadStream(localPath), {
      httpsAgent,
      maxBodyLength: Infinity,
      headers: { "Content-Type": "application/octet-stream" },
      auth: { username: NAS_USER, password: NAS_PASS },
      validateStatus: () => true,
    });

    if (!(response.status >= 200 && response.status < 300))
      throw new Error(`Upload mislukt (${response.status})`);

    logLine("✔ Upload naar NAS voltooid: " + newName);

    //----------------------------------------------------------------
    // CLEANUP – OP BASIS VAN ECHTE SYNOLOGY DATUM + MAP/FOLDER FIX
    //----------------------------------------------------------------
    try {
      const propfind = await axios.request({
        url: base + "/",
        method: "PROPFIND",
        auth: { username: NAS_USER, password: NAS_PASS },
        httpsAgent,
        headers: { Depth: 1, "Content-Type": "application/xml" },
        validateStatus: () => true,
      });

      const xml = propfind.data;

      // Extract D:response blokken
      const blocks = [...xml.matchAll(/<d:response>[\s\S]*?<\/d:response>/g)];

      // Parse entries
      const entries = blocks.map(block => {
        const b = block[0];

        const href = (b.match(/<d:href>(.*?)<\/d:href>/) || [null, null])[1];
        if (!href) return null;

        let nameRaw = decodeURIComponent(href).split("/").pop();
        if (!nameRaw) return null;

        const isDir = /<d:collection\s*\/>/.test(b); // map of bestand

        const name = nameRaw.replace(/\/$/, ""); // trailing slash → weg

        if (!name.endsWith(".zpaq")) return null;

        const modText = (b.match(/<d:getlastmodified>(.*?)<\/d:getlastmodified>/) || [null, null])[1];
        if (!modText) return null;

        const dt = new Date(modText);
        if (isNaN(dt.getTime())) return null;

        return { name, dt, isDir };
      }).filter(x => x !== null);

      // sorteer op echte datum (nieuwste eerst)
      entries.sort((a, b) => b.dt - a.dt);

      // houd 3 nieuwste
      const toDelete = entries.slice(3);

      if (toDelete.length) {
        logLine("Te verwijderen: " + JSON.stringify(toDelete.map(x => x.name)));
      }

      // DELETE uitvoeren
      for (const f of toDelete) {
        const target = `${base}/${f.name}`;

        const delResp = await axios({
          url: target,
          method: "DELETE",
          auth: { username: NAS_USER, password: NAS_PASS },
          httpsAgent,
          validateStatus: () => true
        });

        logLine(`DELETE ${f.isDir ? "folder" : "file"}: ${f.name} → HTTP ${delResp.status}`);
      }

    } catch (cleanupErr) {
      logLine("⚠ Cleanup fout: " + cleanupErr.message);
    }

    //----------------------------------------------------------------
    // WEBHOOK OK
    //----------------------------------------------------------------
    await sendStatusWebhook("OK", {
      filename: newName,
      sizeBytes: stats.size,
      sha1
    });

    res.json({
      success: true,
      filename: newName,
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

// ---------------------------------------------------------------
app.listen(PORT, () => logLine(`Server running on port ${PORT}`));
