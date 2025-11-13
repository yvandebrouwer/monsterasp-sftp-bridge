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
// WEBHOOK NAAR MVC-SITE
// ---------------------------------------------------------------
async function sendStatusWebhook(type, data) {
  const url = process.env.MAIL_WEBHOOK_URL;

  if (!url) {
    logLine("⚠ MAIL_WEBHOOK_URL niet ingesteld");
    return;
  }

  try {
    await axios.post(
      url,
      {
        type,
        filename: data.filename || null,
        sizeBytes: data.sizeBytes || null,
        sha1: data.sha1 || null,
        error: data.error || null,
        time: new Date().toISOString()
      },
      {
        timeout: 10000,
        headers: { "Content-Type": "application/json" }
      }
    );

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
// ROUTES
// ---------------------------------------------------------------
app.get("/", (req, res) => res.send("✅ MonsterASP → Synology NAS Bridge actief"));

app.get("/testmail", async (req, res) => {
  await sendStatusWebhook("TEST", {});
  res.send("✔ Webhook-test verzonden!");
});

// ---------------------------------------------------------------
// /RUN — hoofdflow
// ---------------------------------------------------------------
app.get("/run", async (req, res) => {
  const sftp = new Client();

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    logLine("===== /run gestart =====");
    dumpAllEnv();

    // -----------------------------------------------------------
    // 1️⃣ DOWNLOAD
    // -----------------------------------------------------------
    await sftp.connect({
      host: "bh2.siteasp.net",
      port: 22,
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASS,
    });

    const files = (await sftp.list("/")).filter(f => f.name.endsWith(".zpaq"));
    if (!files.length) throw new Error("Geen .zpaq-bestanden gevonden");

    files.sort((a, b) => b.modifyTime - a.modifyTime); // nieuwste eerst
    const latest = files[0];
    const localPath = path.join(BACKUP_DIR, latest.name);

    logLine("Start download: " + latest.name);
    await sftp.fastGet("/" + latest.name, localPath);
    await sftp.end();

    const stats = fs.statSync(localPath);
    const sha1 = crypto.createHash("sha1").update(fs.readFileSync(localPath)).digest("hex");

    logLine(`✔ Download klaar (${stats.size} bytes, SHA1=${sha1})`);

    // -----------------------------------------------------------
    // 2️⃣ BESTANDSNAAM MET DATUM MAKEN
    // -----------------------------------------------------------
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").split(".")[0];
    const newName = `${latest.name.replace(".zpaq", "")}_${stamp}.zpaq`;

    // -----------------------------------------------------------
    // 3️⃣ UPLOAD NAAR NAS
    // -----------------------------------------------------------
    const NAS_URL = process.env.NAS_URL;
    const NAS_USER = process.env.NAS_USER;
    const NAS_PASS = process.env.NAS_PASS;

    if (!NAS_URL || !NAS_USER || !NAS_PASS) {
      throw new Error("NAS_URL of NAS_USER of NAS_PASS ontbreekt");
    }

    let base = NAS_URL.trim();
    if (base.endsWith("/")) base = base.slice(0, -1);

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

    if (!(response.status >= 200 && response.status < 300)) {
      throw new Error(`Upload mislukt (${response.status})`);
    }

    logLine("✔ Upload naar NAS voltooid: " + newName);

    // -----------------------------------------------------------
    // 4️⃣ CLEANUP — ALLEEN 3 LAATSTE BEWAREN
    // -----------------------------------------------------------
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

      // Alle items ophalen
      let allItems = [...xml.matchAll(/<d:href>(.*?)<\/d:href>/g)]
        .map(m => decodeURIComponent(m[1]))
        .map(x => x.split("/").pop())
        .map(x => x.replace(/\/$/, ""))   // Synology geeft soms een trailing slash
        .filter(x => x && x.endsWith(".zpaq")); // alleen zpaq-bestanden

      // Alleen bestanden met datum-suffix
      let datedFiles = allItems.filter(name =>
        /^.+_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zpaq$/.test(name)
      );

      logLine("Datum-bestanden: " + JSON.stringify(datedFiles));

      if (datedFiles.length > 3) {
        // sorteren op datum in bestandsnaam (nieuwste eerst)
        datedFiles.sort((a, b) => {
          const ta = a.match(/_(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})/)[1].replace(/-/g, "");
          const tb = b.match(/_(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})/)[1].replace(/-/g, "");
          return Number(tb) - Number(ta);
        });

        const toDelete = datedFiles.slice(3); // houd enkel de nieuwste 3

        logLine("Te verwijderen: " + JSON.stringify(toDelete));

        for (const f of toDelete) {
          const delResp = await axios.delete(`${base}/${f}`, {
            auth: { username: NAS_USER, password: NAS_PASS },
            httpsAgent,
            validateStatus: () => true,
          });

          logLine(`Verwijderd: ${f} (HTTP ${delResp.status})`);
        }
      }

    } catch (cleanupErr) {
      logLine("⚠ Cleanup fout: " + cleanupErr.message);
    }

    // -----------------------------------------------------------
    // 5️⃣ MELD SUCCES AAN MVC
    // -----------------------------------------------------------
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
