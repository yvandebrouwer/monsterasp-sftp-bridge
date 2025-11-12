import { google } from "googleapis";
import stream from "stream";

app.get("/run", async (req, res) => {
  const sftp = new Client();
  const remoteDir = "/";

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

    logLine("Start download: " + remoteFile);
    await sftp.fastGet(remoteFile, localPath, { concurrency: 1, chunkSize: 4 * 1024 * 1024 });
    await sftp.end();

    const stats = fs.statSync(localPath);
    logLine(`✔ Download klaar (${stats.size} bytes)`);

    // --- GOOGLE DRIVE UPLOAD ---
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });
    const drive = google.drive({ version: "v3", auth });

    const fileMetadata = {
      name: latest.name,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
    };

    const media = {
      mimeType: "application/octet-stream",
      body: fs.createReadStream(localPath),
    };

    logLine("Upload naar Google Drive gestart...");
    const driveResp = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: "id, webViewLink, name",
    });

    const fileId = driveResp.data.id;
    const fileUrl = driveResp.data.webViewLink;
    logLine(`✔ Upload voltooid: ${fileUrl}`);

    // --- JSON RESPONSE ---
    res.json({
      status: "OK",
      filename: latest.name,
      sizeBytes: stats.size,
      driveFileId: fileId,
      driveUrl: fileUrl,
    });
  } catch (err) {
    logLine("❌ Fout in /run: " + err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});
