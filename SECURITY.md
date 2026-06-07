# Security Policy

## Deployment checklist

- Put SideClip behind HTTPS before exposing it to the public internet.
- Set `COOKIE_SECURE=true` after HTTPS is active.
- Back up the `data/` directory and restrict its filesystem permissions.
- Keep Node.js and your reverse proxy updated.
- Do not commit `.env` or `data/`.
- Review uploaded content and local laws before sharing generated media.

## Current security model

SideClip uses HTTP-only, SameSite cookies; salted `scrypt` password hashes;
same-origin mutation checks; constrained upload types and sizes; rate limiting;
security headers; and owner checks for projects and uploaded media.

Sessions are held in memory and are cleared when the server restarts. This is
intentional for the zero-dependency deployment. Users sign in again afterward.

For security reports, contact the repository owner privately rather than
opening a public issue.
