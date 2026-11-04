<?php
declare(strict_types=1);
/**
 * OAuth 2.1 authorization server for the MCP endpoint, so that "connector" style clients (Claude.ai, ChatGPT, Cursor ...)
 * can connect without anyone pasting a token. Authorization-code flow with PKCE (S256 only), public clients,
 * dynamic client registration (RFC 7591), discovery (RFC 8414 / RFC 9728), refresh-token rotation with reuse detection (RFC 7009 revoke).
 * An ADMIN must approve every connection on the consent screen and chooses the access level.
 */
require __DIR__ . '/lib.php';
require __DIR__ . '/core.php';
require __DIR__ . '/migrate.php';
require __DIR__ . '/auth.php';
$GLOBALS['FAIL_THROWS'] = true;

const ACCESS_TTL = 3600;            // access tokens live one hour
const REFRESH_TTL = 2592000;        // refresh tokens 30 days (rotated on every use)

function oauth_issuer(): string { return app_base_url() . '/api'; }
function oauth_mcp_url(): string { return app_base_url() . '/api/mcp.php'; }
function oauth_url(string $r): string { return oauth_issuer() . '/oauth.php?r=' . $r; }
function b64url(string $bin): string { return rtrim(strtr(base64_encode($bin), '+/', '-_'), '='); }

function oauth_json($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store'); header('Pragma: no-cache');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
function oauth_err(string $err, string $desc, int $code = 400): void { oauth_json(['error' => $err, 'error_description' => $desc], $code); }

function oauth_page(string $title, string $inner, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: text/html; charset=utf-8'); header('Cache-Control: no-store'); header('X-Frame-Options: DENY'); header('Referrer-Policy: no-referrer');
    header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
    $co = htmlspecialchars((string)(get_setting('company_name') ?: 'Infraura'), ENT_QUOTES, 'UTF-8');
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' . htmlspecialchars($title, ENT_QUOTES, 'UTF-8') . '</title><style>
body{margin:0;background:#0a0a0a;color:#f1e9d2;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:18px}.box{max-width:480px;margin:6vh auto;background:#141414;border:1px solid #8a6f1f;border-radius:14px;padding:26px;box-shadow:0 0 40px rgba(212,175,55,.12)}
h1{margin:0 0 6px;font-size:21px;color:#f6e27a}h2{font-size:15px;margin:18px 0 6px;color:#d4af37}p{margin:8px 0}.muted{color:#9b9482;font-size:13px}label{display:block;margin:12px 0 4px;font-weight:600;font-size:13px}input[type=text],input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #3a3320;border-radius:8px;background:#1b1b1b;color:#f1e9d2;font-size:15px}
.opt{display:flex;gap:10px;align-items:flex-start;border:1px solid #3a3320;border-radius:10px;padding:10px 12px;margin:8px 0;cursor:pointer}.opt input{margin-top:4px}.opt b{display:block}.btns{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:12px;border-radius:9px;border:1px solid #3a3320;background:#1b1b1b;color:#f1e9d2;font-size:15px;font-weight:700;cursor:pointer}button.pri{background:linear-gradient(135deg,#f6e27a,#d4af37);color:#000;border-color:#d4af37}
.err{background:#3a1414;border:1px solid #6b2222;color:#fca5a5;padding:10px;border-radius:8px;margin:10px 0}.warn{background:#2a2310;border:1px solid #8a6f1f;color:#f6e27a;padding:10px;border-radius:8px;margin:12px 0;font-size:13px}code{color:#f6e27a;word-break:break-all}ul{margin:6px 0;padding-left:20px}</style></head><body><div class="box"><div style="font-weight:800;color:#d4af37;margin-bottom:10px">' . $co . '</div>' . $inner . '</div></body></html>';
    exit;
}

function oauth_enabled(): bool { return (get_setting('oauth_enabled') ?? '1') !== '0'; }
function valid_redirect_uri(string $u): bool
{
    if ($u === '' || strlen($u) > 500 || strpos($u, '#') !== false || preg_match('/[\x00-\x20"<>\\\\^`{|}]/', $u)) return false;
    $p = parse_url($u); if (!$p || empty($p['scheme'])) return false;
    $sch = strtolower($p['scheme']);
    if (in_array($sch, ['javascript', 'data', 'file', 'vbscript', 'about', 'blob', 'ftp'], true)) return false;
    if ($sch === 'https') return !empty($p['host']);
    if ($sch === 'http') return in_array(strtolower($p['host'] ?? ''), ['localhost', '127.0.0.1', '[::1]'], true);
    return (bool)preg_match('/^[a-z][a-z0-9+.\-]{1,30}$/', $sch);       // private-use schemes of desktop apps (cursor://, vscode://, ...)
}
function find_client(string $id): ?array
{
    $c = q('SELECT * FROM oauth_clients WHERE client_id = ?', [$id])->fetch();
    if (!$c) return null;
    $c['uris'] = json_decode((string)$c['redirect_uris'], true) ?: [];
    return $c;
}
function issue_tokens(array $grant): array
{
    $access = 'qbo_' . bin2hex(random_bytes(24)); $refresh = 'qbr_' . bin2hex(random_bytes(24));
    $cn = q('SELECT name FROM oauth_clients WHERE client_id = ?', [$grant['client_id']])->fetch();
    q('INSERT INTO api_tokens (name,token_hash,prefix,scope,hide_costs,user_id,expires_at,created_at,oauth_client,grant_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ['OAuth: ' . mb_substr((string)($cn['name'] ?? 'app'), 0, 100), hash('sha256', $access), substr($access, 0, 12), $grant['scope'], (int)$grant['hide_costs'], $grant['user_id'], date('Y-m-d H:i:s', time() + ACCESS_TTL), now(), $grant['client_id'], $grant['grant_id']]);
    q('INSERT INTO oauth_refresh (token_hash,client_id,user_id,scope,hide_costs,grant_id,expires_at) VALUES (?,?,?,?,?,?,?)', [hash('sha256', $refresh), $grant['client_id'], $grant['user_id'], $grant['scope'], (int)$grant['hide_costs'], $grant['grant_id'], time() + REFRESH_TTL]);
    return ['access_token' => $access, 'token_type' => 'Bearer', 'expires_in' => ACCESS_TTL, 'refresh_token' => $refresh, 'scope' => $grant['scope'] === 'write' ? 'mcp:read mcp:write' : 'mcp:read'];
}

try {
    config(); ensure_schema();
    $r = (string)($_GET['r'] ?? '');
    $method = $_SERVER['REQUEST_METHOD'];
    $ip = client_ip();

    /* ---------- discovery ---------- */
    if (in_array($r, ['as-metadata', 'wk-authorization-server', 'resource-metadata', 'wk-protected-resource'], true)) {
        if (!oauth_enabled()) oauth_err('not_found', 'OAuth is switched off for this site', 404);
        header('Access-Control-Allow-Origin: *');     // public metadata only
        if (in_array($r, ['resource-metadata', 'wk-protected-resource'], true)) oauth_json(['resource' => oauth_mcp_url(), 'authorization_servers' => [oauth_issuer()], 'scopes_supported' => ['mcp:read', 'mcp:write'], 'bearer_methods_supported' => ['header'], 'resource_name' => 'Infraura Quotation Builder']);
        oauth_json(['issuer' => oauth_issuer(), 'authorization_endpoint' => oauth_url('authorize'), 'token_endpoint' => oauth_url('token'), 'registration_endpoint' => oauth_url('register'), 'revocation_endpoint' => oauth_url('revoke'),
            'response_types_supported' => ['code'], 'grant_types_supported' => ['authorization_code', 'refresh_token'], 'code_challenge_methods_supported' => ['S256'], 'token_endpoint_auth_methods_supported' => ['none'], 'revocation_endpoint_auth_methods_supported' => ['none'],
            'scopes_supported' => ['mcp:read', 'mcp:write'], 'service_documentation' => app_base_url() . '/docs/MCP.md']);
    }
    if (!oauth_enabled()) oauth_err('access_denied', 'OAuth is switched off for this site. Use an access token instead.', 403);

    /* ---------- dynamic client registration ---------- */
    if ($r === 'register') {
        if ($method !== 'POST') oauth_err('invalid_request', 'POST required', 405);
        rate_limit('oreg:' . $ip, 20, 3600);
        $d = json_decode((string)file_get_contents('php://input'), true);
        if (!is_array($d)) oauth_err('invalid_client_metadata', 'JSON body required');
        $uris = $d['redirect_uris'] ?? null;
        if (!is_array($uris) || !$uris || count($uris) > 5) oauth_err('invalid_redirect_uri', 'Provide 1-5 redirect_uris');
        foreach ($uris as $u) if (!is_string($u) || !valid_redirect_uri($u)) oauth_err('invalid_redirect_uri', 'Unacceptable redirect URI (use https, http://localhost, or an app scheme)');
        $am = (string)($d['token_endpoint_auth_method'] ?? 'none');
        if ($am !== 'none') $am = 'none';          // only public clients with PKCE are supported; we answer with what we do support
        $name = trim(preg_replace('/[\x00-\x1f]+/', ' ', (string)($d['client_name'] ?? ''))); $name = $name !== '' ? mb_substr($name, 0, 120) : 'AI assistant';
        if ((int)q('SELECT COUNT(*) AS n FROM oauth_clients')->fetch()['n'] >= 1000) q('DELETE FROM oauth_clients WHERE client_id NOT IN (SELECT client_id FROM oauth_refresh) AND created_at < ?', [date('Y-m-d H:i:s', time() - 86400)]);
        $cid = 'qbc_' . bin2hex(random_bytes(12));
        q('INSERT INTO oauth_clients (client_id,name,redirect_uris,created_at) VALUES (?,?,?,?)', [$cid, $name, json_encode(array_values($uris)), now()]);
        oauth_json(['client_id' => $cid, 'client_name' => $name, 'redirect_uris' => array_values($uris), 'grant_types' => ['authorization_code', 'refresh_token'], 'response_types' => ['code'], 'token_endpoint_auth_method' => 'none', 'client_id_issued_at' => time()], 201);
    }

    /* ---------- authorization (consent screen) ---------- */
    if ($r === 'authorize') {
        start_session();         // sessions are needed only here (consent screen); metadata / token responses never set cookies
        $in = $method === 'POST' ? $_POST : $_GET;
        $client = find_client((string)($in['client_id'] ?? ''));
        $redirect = (string)($in['redirect_uri'] ?? '');
        if (!$client) oauth_page('Cannot connect', '<h1>Cannot connect</h1><div class="err">This app is not registered with us. Go back and try connecting again from the app.</div>', 400);
        if (!in_array($redirect, $client['uris'], true)) oauth_page('Cannot connect', '<h1>Cannot connect</h1><div class="err">The return address does not match what this app registered, so we stopped. Nothing was shared.</div>', 400);
        $state = (string)($in['state'] ?? '');
        $back = function (array $params) use ($redirect, $state) { if ($state !== '') $params['state'] = $state; $params['iss'] = oauth_issuer(); header('Location: ' . $redirect . (strpos($redirect, '?') === false ? '?' : '&') . http_build_query($params), true, 302); exit; };
        if (($in['response_type'] ?? '') !== 'code') $back(['error' => 'unsupported_response_type', 'error_description' => 'Only response_type=code is supported']);
        $challenge = (string)($in['code_challenge'] ?? '');
        if (($in['code_challenge_method'] ?? '') !== 'S256' || !preg_match('/^[A-Za-z0-9_\-]{43,128}$/', $challenge)) $back(['error' => 'invalid_request', 'error_description' => 'PKCE with code_challenge_method=S256 is required']);
        if (!empty($in['resource']) && rtrim((string)$in['resource'], '/') !== oauth_mcp_url()) $back(['error' => 'invalid_target', 'error_description' => 'Unknown resource']);
        $wantWrite = strpos((string)($in['scope'] ?? 'mcp:read mcp:write'), 'mcp:write') !== false || trim((string)($in['scope'] ?? '')) === '';
        $hidden = '';
        foreach (['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'] as $k) if (isset($in[$k])) $hidden .= '<input type="hidden" name="' . $k . '" value="' . htmlspecialchars((string)$in[$k], ENT_QUOTES, 'UTF-8') . '">';
        $self = htmlspecialchars(oauth_url('authorize'), ENT_QUOTES, 'UTF-8');
        $cname = htmlspecialchars($client['name'], ENT_QUOTES, 'UTF-8');
        $host = htmlspecialchars((string)(parse_url($redirect, PHP_URL_HOST) ?: parse_url($redirect, PHP_URL_SCHEME) . ' app'), ENT_QUOTES, 'UTF-8');
        $err = '';

        // 1) sign in (the same account rules as the app: lockouts, 2FA)
        if ($method === 'POST' && ($in['do'] ?? '') === 'login') {
            try {
                $res = authenticate($in);
                if (!empty($res['need_2fa'])) $err = '__2fa__';
                else { session_regenerate_id(true); $u = $res['user']; $_SESSION['user'] = ['id' => (int)$u['id'], 'name' => $u['name'], 'email' => $u['email'], 'role' => $u['role']]; $_SESSION['must_change'] = (int)$u['must_change_password'] === 1; }
            } catch (ApiFailure $e) { $err = $e->getMessage(); }
        }
        $user = current_user();
        if (!$user || !empty($_SESSION['must_change'])) {
            $need2 = $err === '__2fa__';
            oauth_page('Sign in', '<h1>Sign in to continue</h1><p class="muted"><b>' . $cname . '</b> wants to connect to your quotation app. Sign in as an administrator to review the request.</p>' . ($err && !$need2 ? '<div class="err">' . htmlspecialchars($err, ENT_QUOTES, 'UTF-8') . '</div>' : '')
                . '<form method="post" action="' . $self . '">' . $hidden . '<input type="hidden" name="do" value="login"><label>Email</label><input type="email" name="email" required autofocus value="' . htmlspecialchars((string)($in['email'] ?? ''), ENT_QUOTES, 'UTF-8') . '"><label>Password</label><input type="password" name="password" required>'
                . ($need2 ? '<label>6-digit code from your authenticator app (or a recovery code)</label><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus>' : '') . '<div class="btns"><button class="pri">Sign in</button></div></form>', $err && !$need2 ? 401 : 200);
        }
        if ($user['role'] !== 'admin') oauth_page('Admin only', '<h1>Administrator needed</h1><div class="err">Only an administrator can connect AI apps to this account. You are signed in as ' . htmlspecialchars($user['email'], ENT_QUOTES, 'UTF-8') . '.</div>', 403);

        // 2) the decision
        if ($method === 'POST' && in_array($in['do'] ?? '', ['approve', 'deny'], true)) {
            if (!hash_equals((string)($_SESSION['oauth_csrf'] ?? ''), (string)($in['csrf'] ?? ''))) oauth_page('Expired', '<h1>Page expired</h1><div class="err">Please go back to the app and start the connection again.</div>', 400);
            unset($_SESSION['oauth_csrf']);
            if ($in['do'] === 'deny') { audit($user, 'oauth.deny', $client['name']); $back(['error' => 'access_denied', 'error_description' => 'The administrator declined']); }
            $scope = ($in['access'] ?? '') === 'write' && $wantWrite ? 'write' : 'read';
            $code = bin2hex(random_bytes(32)); $grant = bin2hex(random_bytes(16));
            q('INSERT INTO oauth_codes (code_hash,client_id,user_id,scope,hide_costs,redirect_uri,code_challenge,grant_id,expires_at) VALUES (?,?,?,?,?,?,?,?,?)', [hash('sha256', $code), $client['client_id'], $user['id'], $scope, !empty($in['show_costs']) ? 0 : 1, $redirect, $challenge, $grant, time() + 600]);
            audit($user, 'oauth.approve', $client['name'] . ' (' . $scope . (!empty($in['show_costs']) ? ', costs visible' : '') . ')');
            $back(['code' => $code]);
        }
        $_SESSION['oauth_csrf'] = bin2hex(random_bytes(16));
        $co = htmlspecialchars((string)(get_setting('company_name') ?: 'Infraura'), ENT_QUOTES, 'UTF-8');
        oauth_page('Connect ' . $client['name'], '<h1>Connect ' . $cname . '?</h1><p><b>' . $cname . '</b> is asking to use <b>' . $co . '</b> on behalf of <b>' . htmlspecialchars($user['email'], ENT_QUOTES, 'UTF-8') . '</b>.</p>
          <h2>It will be able to</h2><ul><li>Search your quotes, clients, rate cards, projects and reports</li><li>Calculate roofing prices and totals</li></ul>
          <h2>Choose its access</h2><form method="post" action="' . $self . '">' . $hidden . '<input type="hidden" name="csrf" value="' . $_SESSION['oauth_csrf'] . '">
          <label class="opt"><input type="radio" name="access" value="read" checked><span><b>Read only</b>It can look things up and calculate. It cannot change anything.</span></label>'
          . ($wantWrite ? '<label class="opt"><input type="radio" name="access" value="write"><span><b>Read + create draft quotes</b>It can also create or edit <i>draft</i> quotes, add clients and site notes. Drafts are never sent to anyone until a person sends them.</span></label>' : '')
          . '<label class="opt"><input type="checkbox" name="show_costs" value="1"><span><b>Also show my costs and margins</b>Leave off unless you trust this app with your cost prices.</span></label>
          <div class="warn">It can never send quotes, accept or delete anything, record payments, change settings or see other users. You can disconnect it any time in Settings → AI assistants.<br>After you approve, you will be sent back to <code>' . $host . '</code>. Only continue if you started this connection yourself.</div>
          <div class="btns"><button type="submit" name="do" value="deny">Cancel</button><button type="submit" name="do" value="approve" class="pri">Allow</button></div></form>');
    }

    /* ---------- token endpoint ---------- */
    if ($r === 'token') {
        if ($method !== 'POST') oauth_err('invalid_request', 'POST required', 405);
        rate_limit('otok:' . $ip, 60, 600);
        $ct = (string)($_SERVER['CONTENT_TYPE'] ?? '');
        $d = stripos($ct, 'json') !== false ? (json_decode((string)file_get_contents('php://input'), true) ?: []) : $_POST;
        $cid = (string)($d['client_id'] ?? ''); $client = find_client($cid);
        if (!$client) oauth_err('invalid_client', 'Unknown client', 401);
        $gt = (string)($d['grant_type'] ?? '');
        if ($gt === 'authorization_code') {
            $row = q('SELECT * FROM oauth_codes WHERE code_hash = ?', [hash('sha256', (string)($d['code'] ?? ''))])->fetch();
            if (!$row || $row['client_id'] !== $cid) oauth_err('invalid_grant', 'The authorization code is invalid');
            if ((int)$row['used'] === 1) { revoke_grant($row['grant_id']); oauth_err('invalid_grant', 'This code was already used. All tokens from it have been revoked.'); }
            if ((int)$row['expires_at'] < time()) oauth_err('invalid_grant', 'The authorization code has expired');
            if (!hash_equals($row['redirect_uri'], (string)($d['redirect_uri'] ?? ''))) oauth_err('invalid_grant', 'redirect_uri does not match');
            $ver = (string)($d['code_verifier'] ?? '');
            if (!preg_match('/^[A-Za-z0-9\-._~]{43,128}$/', $ver) || !hash_equals($row['code_challenge'], b64url(hash('sha256', $ver, true)))) oauth_err('invalid_grant', 'PKCE verification failed');
            if (q('UPDATE oauth_codes SET used = 1 WHERE code_hash = ? AND used = 0', [$row['code_hash']])->rowCount() !== 1) { revoke_grant($row['grant_id']); oauth_err('invalid_grant', 'This code was already used.'); }
            $u = q('SELECT role FROM users WHERE id = ?', [$row['user_id']])->fetch();
            if (!$u || $u['role'] !== 'admin') oauth_err('invalid_grant', 'The approving user is no longer an administrator');
            oauth_json(issue_tokens($row));
        }
        if ($gt === 'refresh_token') {
            $h = hash('sha256', (string)($d['refresh_token'] ?? '')); $row = q('SELECT * FROM oauth_refresh WHERE token_hash = ?', [$h])->fetch();
            if (!$row || $row['client_id'] !== $cid) oauth_err('invalid_grant', 'The refresh token is invalid');
            if ((int)$row['revoked'] === 1) { revoke_grant($row['grant_id']); oauth_err('invalid_grant', 'This refresh token was already used or revoked. The connection has been closed for safety - connect again.'); }
            if ((int)$row['expires_at'] < time()) oauth_err('invalid_grant', 'The refresh token has expired - connect again');
            if (q('UPDATE oauth_refresh SET revoked = 1 WHERE token_hash = ? AND revoked = 0', [$h])->rowCount() !== 1) { revoke_grant($row['grant_id']); oauth_err('invalid_grant', 'This refresh token was already used.'); }
            $u = q('SELECT role FROM users WHERE id = ?', [$row['user_id']])->fetch();
            if (!$u || $u['role'] !== 'admin') { revoke_grant($row['grant_id']); oauth_err('invalid_grant', 'The approving user is no longer an administrator'); }
            q('UPDATE api_tokens SET revoked = 1 WHERE grant_id = ?', [$row['grant_id']]);     // the previous access token dies with the rotation
            oauth_json(issue_tokens($row));
        }
        oauth_err('unsupported_grant_type', 'Use authorization_code or refresh_token');
    }

    /* ---------- revocation (RFC 7009) ---------- */
    if ($r === 'revoke') {
        if ($method !== 'POST') oauth_err('invalid_request', 'POST required', 405);
        rate_limit('orev:' . $ip, 60, 600);
        $d = $_POST ?: (json_decode((string)file_get_contents('php://input'), true) ?: []);
        $h = hash('sha256', (string)($d['token'] ?? ''));
        $rf = q('SELECT grant_id FROM oauth_refresh WHERE token_hash = ?', [$h])->fetch(); $ac = q('SELECT grant_id FROM api_tokens WHERE token_hash = ? AND oauth_client IS NOT NULL', [$h])->fetch();
        if ($rf) revoke_grant($rf['grant_id']); elseif ($ac && $ac['grant_id']) revoke_grant($ac['grant_id']);
        oauth_json(new stdClass());        // always 200, whether or not the token existed
    }
    oauth_err('not_found', 'Unknown endpoint', 404);
} catch (ApiFailure $e) {
    oauth_err('server_error', $e->getMessage(), $e->getCode() >= 400 && $e->getCode() < 600 ? $e->getCode() : 400);
} catch (Throwable $e) {
    app_log_error('OAuth error: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    oauth_err('server_error', 'Internal error', 500);
}
