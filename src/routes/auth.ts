import { Router } from "express";
import crypto from "crypto";
import { generatePkcePair, buildAuthorizeUrl, exchangeCodeForToken, connectionFor } from "../auth/salesforceAuth";

export const authRouter = Router();

/** Kicks off per-visit OAuth — nothing is persisted before or after this. */
authRouter.get("/login", (req, res) => {
  const { codeVerifier, codeChallenge } = generatePkcePair();
  const state = crypto.randomBytes(16).toString("hex");

  req.session.pkceCodeVerifier = codeVerifier;
  req.session.oauthState = state;

  res.redirect(buildAuthorizeUrl(codeChallenge, state));
});

authRouter.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || typeof code !== "string") {
    return res.status(400).send("Missing authorization code");
  }
  if (!req.session.pkceCodeVerifier || state !== req.session.oauthState) {
    return res.status(400).send("Invalid or expired OAuth state — please try logging in again");
  }

  try {
    const session = await exchangeCodeForToken(code, req.session.pkceCodeVerifier);
    req.session.salesforce = session;
    delete req.session.pkceCodeVerifier;
    delete req.session.oauthState;

    // Resolve the running user's Id up front — used later as the
    // correlation key for DML capture (design doc Section 4.7).
    const identity = await connectionFor(session).identity();
    req.session.runningUserId = identity.user_id;

    // Front-end picks up from here to show the environment/flow picker.
    res.redirect("/");
  } catch (err) {
    res.status(500).send(`OAuth callback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

authRouter.get("/status", (req, res) => {
  res.json({ authenticated: Boolean(req.session.salesforce) });
});
