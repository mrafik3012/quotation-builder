<?php
declare(strict_types=1);

date_default_timezone_set('Asia/Kolkata');

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
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
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

/** Returns [subtotal, discount, tax, round_off, total] */
function compute_totals(array $data): array
{
    $sub = 0.0;
    foreach (effective_sections($data) as $s) {
        foreach (($s['items'] ?? []) as $it) {
            $sub += round(num($it['qty'] ?? 0) * num($it['rate'] ?? 0), 2);
        }
    }
    $d = $data['discount'] ?? ['type' => 'percent', 'value' => 0];
    $dv = num($d['value'] ?? 0);
    $disc = (($d['type'] ?? 'percent') === 'flat') ? $dv : $sub * $dv / 100;
    $disc = min(max($disc, 0.0), $sub);
    $taxable = $sub - $disc;
    $tax = round($taxable * num($data['tax_rate'] ?? 18) / 100, 2);
    $total = $taxable + $tax;
    $round = 0.0;
    if (!empty($data['round_off'])) {
        $r = round($total);
        $round = round($r - $total, 2);
        $total = $r;
    }
    return [round($sub, 2), round($disc, 2), $tax, $round, round($total, 2)];
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
