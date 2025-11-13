import nodemailer from "nodemailer";

console.log("🚀 SMTP TEST START");

async function run() {
  try {
    const t = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
      }
    });

    const info = await t.sendMail({
      from: process.env.GMAIL_USER,
      to: "debrouweryvan@gmail.com",
      subject: "SMTP TEST — Render",
      text: "Dit is een testmail vanuit Render via Gmail SMTP."
    });

    console.log("✔ MAIL VERZONDEN!");
    console.log(info);

  } catch (err) {
    console.log("❌ SMTP FOUT:");
    console.log(err.message);
  }
}

run();
