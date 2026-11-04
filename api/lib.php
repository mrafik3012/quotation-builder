<?php
declare(strict_types=1);

date_default_timezone_set('Asia/Kolkata');
// Never leak PHP errors to visitors; they go to the server error log instead.
ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

const DIVISIONS =['roofing' => 'Sheet Roofing', 'interior' => 'Interior', 'construction' => 'Construction', 'pmc' => 'PMC'];
const DIV_CODES = ['roofing' => 'RF', 'interior' => 'IN', 'construction' => 'CN', 'pmc' => 'PM'];
const STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'superseded'];

function json_out($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
    exit;
}

function fail(string $msg, int $code = 400): void
{
    json_out(['error' => $msg], $code);
}

function config(): array
{
    static $c = null;
    if ($c === null) {
        $f = __DIR__ . '/config.php';
        if (!is_file($f)) {
            fail('not_installed', 503);
        }
        $c = require $f;
    }
    return $c;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo) {
        return $pdo;
    }
    $c = config();
    $opt = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC];
    if (($c['driver'] ?? 'mysql') === 'sqlite') {
        $pdo = new PDO('sqlite:' . $c['sqlite_path'], null, null, $opt);
        $pdo->exec('PRAGMA foreign_keys=ON');
    } else {
        $dsn = 'mysql:host=' . $c['host'] . ';dbname=' . $c['name'] . ';charset=utf8mb4';
        $pdo = new PDO($dsn, $c['user'], $c['pass'], $opt + [PDO::ATTR_EMULATE_PREPARES => false]);
    }
    return $pdo;
}

function q(string $sql, array $params = []): PDOStatement
{
    $st = db()->prepare($sql);
    $st->execute($params);
    return $st;
}

function now(): string
{
    return date('Y-m-d H:i:s');
}

function body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return [];
    }
    $d = json_decode($raw, true);
    if (!is_array($d)) {
        fail('Invalid JSON body');
    }
    return $d;
}

function start_session(): void
{
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    ini_set('session.gc_maxlifetime', '28800');
    ini_set('session.use_strict_mode', '1');
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => $secure, 'httponly' => true, 'samesite' => 'Lax']);
    session_name('infraura_sid');
    session_start();
}

function current_user(): ?array
{
    return $_SESSION['user'] ?? null;
}

function require_auth(): array
{
    $u = current_user();
    if (!$u) {
        fail('Not signed in', 401);
    }
    return $u;
}

function require_admin(): array
{
    $u = require_auth();
    if (($u['role'] ?? '') !== 'admin') {
        fail('Admin only', 403);
    }
    return $u;
}

function str($v, int $max = 255): string
{
    return mb_substr(trim((string)($v ?? '')), 0, $max);
}

function num($v): float
{
    return is_numeric($v) ? (float)$v : 0.0;
}

/** Common sections plus the selected optional package (if any). */
function effective_sections(array $data): array
{
    $secs = $data['sections'] ?? [];
    $opts = $data['options'] ?? [];
    if (is_array($opts) && $opts) {
        $i = (int)($data['selected_option'] ?? 0);
        $o = $opts[$i] ?? $opts[0];
        $secs = array_merge($secs, $o['sections'] ?? []);
    }
    return $secs;
}

/** Money rounding: half away from zero on the exact decimal value. Identical to r2() in assets/app.js. */
function money(float $x): float
{
    $y = abs($x) * 100;
    return ($x < 0 ? -1 : 1) * floor(round($y, 4) + 0.5) / 100;
}

const MAX_AMOUNT = 10000000000.0; // 1,000 crore per line / quote: far beyond any real job, well inside DECIMAL(14,2)

/** Sliding-window limiter stored in the DB. Fails with 429 when the key exceeds $max hits in $window seconds. */
function rate_limit(string $key, int $max, int $window, bool $countOnly = false): void
{
    $key = substr($key, 0, 80);
    $now = time();
    if (random_int(1, 50) === 1) q('DELETE FROM rate_limits WHERE window_start < ?', [$now - 7200]);
    $r = q('SELECT hits, window_start FROM rate_limits WHERE k = ?', [$key])->fetch();
    if (!$r || $now - (int)$r['window_start'] > $window) {
        if ($r) q('UPDATE rate_limits SET hits = 1, window_start = ? WHERE k = ?', [$now, $key]);
        else { try { q('INSERT INTO rate_limits (k,hits,window_start) VALUES (?,?,?)', [$key, 1, $now]); } catch (PDOException $e) { /* raced: another request created it */ } }
        return;
    }
    if ((int)$r['hits'] >= $max) fail('Too many attempts. Please wait a few minutes and try again.', 429);
    if (!$countOnly) q('UPDATE rate_limits SET hits = hits + 1 WHERE k = ?', [$key]);
}
function rate_limit_peek(string $key, int $max, int $window): bool
{ // true when the key is already at its limit (does not count a hit)
    $r = q('SELECT hits, window_start FROM rate_limits WHERE k = ?', [substr($key, 0, 80)])->fetch();
    return $r && time() - (int)$r['window_start'] <= $window && (int)$r['hits'] >= $max;
}
function rate_limit_hit(string $key, int $window): void
{
    $key = substr($key, 0, 80); $now = time();
    $r = q('SELECT window_start FROM rate_limits WHERE k = ?', [$key])->fetch();
    if (!$r || $now - (int)$r['window_start'] > $window) { q('DELETE FROM rate_limits WHERE k = ?', [$key]); try { q('INSERT INTO rate_limits (k,hits,window_start) VALUES (?,?,?)', [$key, 1, $now]); } catch (PDOException $e) {} }
    else q('UPDATE rate_limits SET hits = hits + 1 WHERE k = ?', [$key]);
}
function client_ip(): string
{
    return substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45);
}

/** Returns [subtotal, discount, tax, round_off, total] */
function compute_totals(array $data): array
{
    $sub = 0.0;
    foreach (effective_sections($data) as $s) {
        foreach (($s['items'] ?? []) as $it) {
            $sub += money(num($it['qty'] ?? 0) * num($it['rate'] ?? 0));
        }
    }
    $sub = money($sub);
    $d = $data['discount'] ?? ['type' => 'percent', 'value' => 0];
    $dv = num($d['value'] ?? 0);
    $disc = (($d['type'] ?? 'percent') === 'flat') ? $dv : $sub * $dv / 100;
    $disc = money(min(max($disc, 0.0), $sub));
    $taxable = $sub - $disc;
    $tax = money($taxable * num($data['tax_rate'] ?? 18) / 100);
    $total = $taxable + $tax;
    $round = 0.0;
    if (!empty($data['round_off'])) {
        $r = floor(money($total) + 0.5);
        $round = money($r - $total);
        $total = $r;
    }
    return [money($sub), money($disc), $tax, $round, money($total)];
}

function financial_year(string $date): string
{
    $t = strtotime($date) ?: time();
    $y = (int)date('Y', $t);
    $m = (int)date('n', $t);
    $start = $m >= 4 ? $y : $y - 1;
    return sprintf('%02d-%02d', $start % 100, ($start + 1) % 100);
}

function next_quote_no(string $division, string $date): string
{
    $prefix = (string)(get_setting('quote_prefix') ?: 'INF');
    $head = $prefix . '/' . DIV_CODES[$division] . '/' . financial_year($date) . '/';
    $rows = q('SELECT quote_no FROM quotes WHERE quote_no LIKE ?', [$head . '%'])->fetchAll();
    $max = 0;
    foreach ($rows as $r) {
        $n = (int)substr($r['quote_no'], strlen($head));
        $max = max($max, $n);
    }
    return $head . str_pad((string)($max + 1), 4, '0', STR_PAD_LEFT);
}

function get_setting(string $k): ?string
{
    $r = q('SELECT v FROM settings WHERE k = ?', [$k])->fetch();
    return $r ? (string)$r['v'] : null;
}

function set_setting(string $k, string $v): void
{
    $exists = q('SELECT 1 FROM settings WHERE k = ?', [$k])->fetch();
    if ($exists) {
        q('UPDATE settings SET v = ? WHERE k = ?', [$v, $k]);
    } else {
        q('INSERT INTO settings (k, v) VALUES (?, ?)', [$k, $v]);
    }
}
