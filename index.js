import fs from "fs";
import express from "express";
import Client from "ssh2-sftp-client";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import https from "https";
import { XMLParser } from "fast-xml-parser";   // <-- NIEUW

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

app.get("/keepalive", (req, res) => {
  res.send("OK");
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
    // 1. DOWNLOAD
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
    // 2. NIEUWE BESTANDSNAAM
    //----------------------------------------------------------------
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").split(".")[0];
    const newName = `${latest.name.replace(".zpaq", "")}_${stamp}.zpaq`;

    //----------------------------------------------------------------
    // 3. UPLOAD NAAR NAS VIA WEBDAV
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
    // 4. CLEANUP — PROPFIND PARSEN MET XMLPARSER
    //----------------------------------------------------------------
    try {
      const propfind = await axios.request({
        url: base + "/",
        method: "PROPFIND",
        auth: { username: NAS_USER, password: NAS_PASS },
        httpsAgent,
        headers: {
          Depth: 1,
          "Content-Type": "application/xml"
        },
        validateStatus: () => true,
      });

      const xml = propfind.data;

      const parser = new XMLParser({
        ignoreAttributes: false,
        ignoreDeclaration: true,
        removeNSPrefix: false
      });

      const json = parser.parse(xml);

      // Zoek de multistatus node en responses (ongeacht prefix d:/D:/whatever)
      function findResponses(obj) {
        if (!obj || typeof obj !== "object") return null;

        for (const key of Object.keys(obj)) {
          const val = obj[key];
          const lower = key.toLowerCase();
          if (lower.endsWith("multistatus")) {
            // hierbinnen moeten de response nodes zitten
            const resp =
              val["d:response"] ||
              val["D:response"] ||
              val["response"] ||
              val["ns0:response"];

            if (!resp) return [];
            return Array.isArray(resp) ? resp : [resp];
          }

          if (typeof val === "object") {
            const r = findResponses(val);
            if (r) return r;
          }
        }
        return null;
      }

      const responses = findResponses(json) || [];
      logLine("PROPFIND responses ontvangen: " + responses.length);

      // Helper: uit één response href, lastmodified en resourcetype halen
      function parseEntry(resp) {
        if (!resp) return null;

        const href =
          resp["d:href"] ||
          resp["D:href"] ||
          resp["href"] ||
          resp["ns0:href"];

        if (!href) return null;

        // propstat kan array of object zijn
        const propstatRaw =
          resp["d:propstat"] ||
          resp["D:propstat"] ||
          resp["propstat"] ||
          resp["ns0:propstat"];

        const propstats = Array.isArray(propstatRaw)
          ? propstatRaw
          : propstatRaw ? [propstatRaw] : [];

        let props = null;
        for (const ps of propstats) {
          const status = (ps["d:status"] || ps["D:status"] || ps["status"] || "").toString();
          if (!status || status.indexOf("200") !== -1) {
            props =
              ps["d:prop"] ||
              ps["D:prop"] ||
              ps["prop"] ||
              ps["ns0:prop"] ||
              ps;
            break;
          }
        }
        if (!props) return null;

        // getlastmodified zoeken (ongeacht prefix)
        let lastmod = null;
        let resourcetype = null;

        for (const k of Object.keys(props)) {
          const lk = k.toLowerCase();
          if (!lastmod && lk.endsWith("getlastmodified")) {
            lastmod = props[k];
          }
          if (!resourcetype && lk.endsWith("resourcetype")) {
            resourcetype = props[k];
          }
        }

        if (!lastmod) return null;

        const dt = new Date(lastmod);
        if (isNaN(dt.getTime())) return null;

        // is folder / collectie?
        let isDir = false;
        if (resourcetype && typeof resourcetype === "object") {
          for (const k of Object.keys(resourcetype)) {
            if (k.toLowerCase().includes("collection")) {
              isDir = true;
              break;
            }
          }
        }

        // naam uit href halen
        const parts = decodeURIComponent(href).split("/").filter(Boolean);
        if (!parts.length) return null;
        const name = parts[parts.length - 1].replace(/\/$/, "");

        // root-directory zelf overslaan
        if (!name) return null;

        return { name, dt, isDir };
      }

      const allEntries = responses
        .map(parseEntry)
        .filter(e => e && e.name.toLowerCase().endsWith(".zpaq"));

      logLine("ZPAQ entries gevonden via PROPFIND: " +
        JSON.stringify(allEntries.map(e => ({ name: e.name, dt: e.dt }))));

      // sorteer op lastmodified, nieuwste eerst
      allEntries.sort((a, b) => b.dt - a.dt);

      if (allEntries.length > 3) {
        const toDelete = allEntries.slice(3);
        logLine("Te verwijderen (oudste eerst): " +
          JSON.stringify(toDelete.map(x => ({ name: x.name, dt: x.dt }))));

        for (const f of toDelete) {
          const target = `${base}/${f.name}`;

          const delResp = await axios({
            url: target,
            method: "DELETE",
            auth: { username: NAS_USER, password: NAS_PASS },
            httpsAgent,
            validateStatus: () => true
          });

          logLine(`DELETE ${f.isDir ? "collection" : "file"}: ${f.name} → HTTP ${delResp.status}`);
        }
      } else {
        logLine("Cleanup: minder dan of gelijk aan 3 .zpaq, niets te verwijderen");
      }

    } catch (cleanupErr) {
      logLine("⚠ Cleanup fout: " + cleanupErr.message);
    }

    //----------------------------------------------------------------
    // 5. WEBHOOK OK
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

