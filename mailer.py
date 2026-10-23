"""Outgoing mail for Le Kiosque (password reset links), through the hodologic.fr
mailbox at Hostinger. SMTP_HOST, SMTP_PORT and SMTP_USER are plain settings in
.env.docker; SMTP_PASSWORD is set there on the server only, never in the repo."""
from __future__ import annotations

import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

SMTP_HOST = os.getenv("SMTP_HOST", "smtp.hostinger.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "465"))
SMTP_USER = os.getenv("SMTP_USER", "noreply@hodologic.fr")


def configured() -> bool:
    return bool(os.getenv("SMTP_PASSWORD"))


def send(to: str, subject: str, text: str, html: str | None = None) -> None:
    msg = EmailMessage()
    msg["From"] = formataddr(("Le Kiosque", SMTP_USER))
    msg["To"] = to
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=SMTP_USER.split("@")[-1])
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context(), timeout=20) as s:
        s.login(SMTP_USER, os.environ["SMTP_PASSWORD"])
        s.send_message(msg)
