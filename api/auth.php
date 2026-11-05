<?php
declare(strict_types=1);
// Account security helpers: TOTP two-step sign-in (RFC 6238), recovery codes, temporary passwords.
require_once __DIR__ . '/lib.php';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32_encode(string $bin): string
{
    $bits = ''; foreach (str_split($bin) as $ch) $bits .= str_pad(decbin(ord($ch)), 8, '0', STR_PAD_LEFT);
    $out = ''; foreach (str_split($bits, 5) as $chunk) $out .= B32[bindec(str_pad($chunk, 5, '0'))];
    return $out;
}
function b32_decode(string $s): string
{
    $s = strtoupper(preg_replace('/[^A-Z2-7]/i', '', $s)); $bits = '';
    foreach (str_split($s) as $ch) $bits .= str_pad(decbin(strpos(B32, $ch)), 5, '0', STR_PAD_LEFT);
    $out = ''; foreach (str_split($bits, 8) as $byte) if (strlen($byte) === 8) $out .= chr(bindec($byte));
    return $out;
}
function totp_new_secret(): string { return b32_encode(random_bytes(20)); }
function totp_at(string $secret, int $counter): string
{
    $h = hash_hmac('sha1', pack('N*', 0, $counter), b32_decode($secret), true);
    $o = ord($h[19]) & 0xf;
    $n = ((ord($h[$o]) & 0x7f) << 24) | ((ord($h[$o + 1]) & 0xff) << 16) | ((ord($h[$o + 2]) & 0xff) << 8) | (ord($h[$o + 3]) & 0xff);
    return str_pad((string)($n % 1000000), 6, '0', STR_PAD_LEFT);
}
/** Verify a 6-digit code (+/- one 30-second step). Returns the matched counter, or 0. A counter can never be used twice. */
function totp_verify(string $secret, string $code, int $lastUsed, ?int $now = null): int
{
    $code = preg_replace('/\s+/', '', $code);
    if (!preg_match('/^\d{6}$/', $code)) return 0;
    $ctr = intdiv($now ?? time(), 30);
    for ($i = -1; $i <= 1; $i++) {
        $c = $ctr + $i;
        if ($c > $lastUsed && hash_equals(totp_at($secret, $c), $code)) return $c;
    }
    return 0;
}
function totp_uri(string $secret, string $account, string $issuer): string
{
    return 'otpauth://totp/' . rawurlencode($issuer . ':' . $account) . '?secret=' . $secret . '&issuer=' . rawurlencode($issuer) . '&algorithm=SHA1&digits=6&period=30';
}
/** Returns [plain codes, json of sha256 hashes] */
function make_recovery_codes(int $n = 8): array
{
    $plain = []; $hashes = [];
    for ($i = 0; $i < $n; $i++) { $c = strtolower(substr(b32_encode(random_bytes(7)), 0, 5) . '-' . substr(b32_encode(random_bytes(7)), 0, 5)); $plain[] = $c; $hashes[] = hash('sha256', $c); }
    return [$plain, json_encode($hashes)];
}
/** If $code is an unused recovery code for this user, consume it and return true. */
function use_recovery_code(array $user, string $code): bool
{
    $code = strtolower(trim($code));
    if (!preg_match('/^[a-z2-7]{5}-[a-z2-7]{5}$/', $code)) return false;
    $list = json_decode((string)($user['recovery_codes'] ?? ''), true) ?: [];
    $h = hash('sha256', $code); $i = array_search($h, $list, true);
    if ($i === false) return false;
    array_splice($list, (int)$i, 1);
    q('UPDATE users SET recovery_codes = ? WHERE id = ?', [json_encode(array_values($list)), $user['id']]);
    return true;
}
function temp_password(int $len = 12): string
{
    $alpha = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'; $out = '';
    for ($i = 0; $i < $len; $i++) $out .= $alpha[random_int(0, strlen($alpha) - 1)];
    return $out;
}
function admin_count(): int { return (int)q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")->fetch()['n']; }

/**
 * Check email + password (+ 2FA code when enabled). Applies the sign-in lockouts.
 * Returns ['user' => row] on success, ['need_2fa' => true] when a code is still required; otherwise calls fail().
 */
function authenticate(array $d): array
{
    $email = strtolower(str($d['email'] ?? '', 190));
    $kUser = 'login:' . substr(hash('sha256', $email . '|' . client_ip()), 0, 40);
    $kIp = 'loginip:' . client_ip();
    if (rate_limit_peek($kUser, 5, 900) || rate_limit_peek($kIp, 60, 900)) fail('Too many failed sign-in attempts. Please wait 15 minutes and try again.', 429);
    $u = q('SELECT * FROM users WHERE email = ?', [$email])->fetch();
    if (!$u || !password_verify((string)($d['password'] ?? ''), $u['password_hash'])) {
        rate_limit_hit($kUser, 900); rate_limit_hit($kIp, 900);
        usleep(600000);
        fail('Incorrect email or password', 401);
    }
    if ((int)$u['totp_enabled'] === 1) {
        $code = trim((string)($d['code'] ?? ''));
        if ($code === '') return ['need_2fa' => true];
        $good = false;
        $ctr = totp_verify((string)$u['totp_secret'], $code, (int)$u['totp_last']);
        if ($ctr) { q('UPDATE users SET totp_last = ? WHERE id = ?', [$ctr, $u['id']]); $good = true; }
        elseif (use_recovery_code($u, $code)) { $good = true; audit(['name' => $u['name']], '2fa.recovery_used', $u['email']); }
        if (!$good) { rate_limit_hit($kUser, 900); rate_limit_hit($kIp, 900); usleep(600000); fail('That code is not valid. Use the current code from your authenticator app, or a recovery code.', 401); }
    }
    q('DELETE FROM rate_limits WHERE k = ?', [$kUser]);
    return ['user' => $u];
}
