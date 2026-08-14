import "express-session";
import { SalesforceSession } from "../auth/salesforceAuth";

declare module "express-session" {
  interface SessionData {
    pkceCodeVerifier?: string;
    oauthState?: string;
    salesforce?: SalesforceSession;
    runningUserId?: string;
  }
}
