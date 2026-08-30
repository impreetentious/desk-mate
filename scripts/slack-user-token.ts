import http from "node:http";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import manifest from "../test/live-slack/qa-driver.manifest.json" with { type: "json" };

const PORT = Number(process.env.PORT) || 3000;
const REDIRECT = `http://localhost:${PORT}/slack/callback`;
const USER_SCOPES = manifest.oauth_config.scopes.user.join(",");

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (from the QA Driver app → Basic Information)`);
  return v;
}

async function main(): Promise<void> {
  const clientId = req("SLACK_CLIENT_ID");
  const clientSecret = req("SLACK_CLIENT_SECRET");
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}&user_scope=${encodeURIComponent(USER_SCOPES)}&redirect_uri=${encodeURIComponent(REDIRECT)}`;

  const token = await new Promise<{ token: string; user: string; team: string }>((resolve, reject) => {
    const server = http.createServer(async (r, res) => {
      const u = new URL(r.url ?? "", `http://localhost:${PORT}`);
      if (u.pathname !== "/slack/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get("code");
      if (!code) {
        res.writeHead(400).end("no code");
        return;
      }
      try {
        const body = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: REDIRECT,
        });
        const resp = await fetch("https://slack.com/api/oauth.v2.access", { method: "POST", body });
        const data = (await resp.json()) as any;
        if (!data.ok || !data.authed_user?.access_token) {
          throw new Error(`oauth.v2.access failed: ${String(data.error ?? "unknown_error")}`);
        }
        res
          .writeHead(200, { "content-type": "text/html" })
          .end("<h2>Token captured — you can close this tab and return to the terminal.</h2>");
        server.close();
        resolve({
          token: data.authed_user.access_token,
          user: data.authed_user.id,
          team: data.team?.name ?? data.team?.id ?? "?",
        });
      } catch (err) {
        res.writeHead(500).end(String(err));
        server.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    server.listen(PORT, () => {
      console.log(`\nOpening Slack authorize page. Sign in as the account you want a token for, then Approve.`);
      console.log(`If the browser doesn't open, visit:\n${authUrl}\n`);
      spawn("open", [authUrl], { stdio: "ignore" }).on("error", () => {});
    });
  });

  const output = resolve(process.env.SLACK_USER_TOKEN_OUT ?? ".generated/slack-user-token.env");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, `LIVE_E2E_SLACK_QA_USER_TOKEN=${token.token}\n`, { mode: 0o600 });
  chmodSync(output, 0o600);
  console.log(`\nCaptured a user token for <@${token.user}> in ${token.team}.`);
  console.log(`Saved it to ${output} (mode 0600); the token was not printed.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
