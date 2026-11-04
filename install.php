<?php
declare(strict_types=1);
/**
 * One-time installer. Open https://your-domain/install.php, fill the form, then DELETE this file.
 * CLI (for testing):  php install.php --sqlite --email=a@b.com --password=secret123
 */
require __DIR__ . '/api/setup.php';

$configFile = __DIR__ . '/api/config.php';
$cli = PHP_SAPI === 'cli';

function page(string $title, string $inner): void
{
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' . htmlspecialchars($title) . '</title>
<style>body{font-family:system-ui,sans-serif;background:#f1f5f9;margin:0;padding:24px;color:#0f172a}.box{max-width:520px;margin:30px auto;background:#fff;padding:28px;border-radius:12px;box-shadow:0 2px 14px rgba(0,0,0,.08)}
h1{margin:0 0 6px;font-size:22px}p.s{color:#64748b;margin:0 0 18px}label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:15px}
button{margin-top:20px;width:100%;padding:12px;background:#b45309;color:#fff;border:0;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer}.err{background:#fee2e2;color:#991b1b;padding:10px;border-radius:8px;margin-bottom:10px}.ok{background:#dcfce7;color:#166534;padding:12px;border-radius:8px}h3{margin:22px 0 0;font-size:14px;color:#b45309;text-transform:uppercase;letter-spacing:.05em}</style></head><body><div class="box">' . $inner . '</div></body></html>';
}

if (is_file($configFile)) {
    $msg = 'Already installed. For security, delete install.php from the server.';
    if ($cli) { fwrite(STDERR, $msg . "\n"); exit(1); }
    page('Installed', '<h1>Already installed</h1><p class="s">' . $msg . '</p>');
    exit;
}

function do_install(array $in): string
{
    global $configFile;
    $driver = $in['driver'];
    $adminEmail = trim($in['email']);
    if (!filter_var($adminEmail, FILTER_VALIDATE_EMAIL)) throw new RuntimeException('Enter a valid admin email.');
    if (strlen($in['password']) < 8) throw new RuntimeException('Password must be at least 8 characters.');

    if ($driver === 'sqlite') {
        $dir = __DIR__ . '/api/data';
        if (!is_dir($dir)) mkdir($dir, 0750, true);
        file_put_contents($dir . '/.htaccess', "Require all denied\n");
        $cfg = ['driver' => 'sqlite', 'sqlite_path' => $dir . '/app.sqlite'];
        if (is_file($cfg['sqlite_path'])) unlink($cfg['sqlite_path']);
        $pdo = new PDO('sqlite:' . $cfg['sqlite_path'], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    } else {
        $cfg = ['driver' => 'mysql', 'host' => $in['host'], 'name' => $in['dbname'], 'user' => $in['dbuser'], 'pass' => $in['dbpass']];
        $pdo = new PDO('mysql:host=' . $cfg['host'] . ';dbname=' . $cfg['name'] . ';charset=utf8mb4', $cfg['user'], $cfg['pass'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $exists = $pdo->query("SHOW TABLES LIKE 'quotes'")->fetch();
        if ($exists) throw new RuntimeException('Tables already exist in this database. Use an empty database.');
    }
    install_database($pdo, $driver, $in['company'] ?: 'Infraura', $in['name'] ?: 'Admin', $adminEmail, $in['password']);
    file_put_contents($configFile, "<?php\nreturn " . var_export($cfg, true) . ";\n");
    @chmod($configFile, 0640);
    return 'Installation complete.';
}

if ($cli) {
    $o = getopt('', ['sqlite', 'email:', 'password:']);
    echo do_install([
        'driver' => isset($o['sqlite']) ? 'sqlite' : 'mysql', 'email' => $o['email'] ?? 'admin@example.com',
        'password' => $o['password'] ?? 'changeme123', 'company' => 'Infraura', 'name' => 'Admin',
        'host' => 'localhost', 'dbname' => '', 'dbuser' => '', 'dbpass' => '',
    ]) . "\n";
    exit;
}

$err = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        $in = array_map(fn($v) => is_string($v) ? trim($v) : '', $_POST);
        $in += ['driver' => 'mysql', 'host' => 'localhost', 'dbname' => '', 'dbuser' => '', 'dbpass' => '', 'company' => '', 'name' => '', 'email' => '', 'password' => ''];
        do_install($in);
        page('Done', '<h1>Installed ✔</h1><div class="ok"><p>Infraura Quotation Builder is ready.</p><p><b>Now delete <code>install.php</code> from your server</b>, then <a href="./">sign in</a> with the admin email and password you just set.</p></div>');
        exit;
    } catch (Throwable $e) {
        $err = $e->getMessage();
    }
}
$v = fn(string $k, string $d = '') => htmlspecialchars($_POST[$k] ?? $d);
page('Install', '<h1>Infraura Quotation Builder</h1><p class="s">One-time setup. Create an empty MySQL database in Hostinger hPanel first (Databases → MySQL Databases).</p>'
    . ($err ? '<div class="err">' . htmlspecialchars($err) . '</div>' : '')
    . '<form method="post"><h3>Database</h3>
<label>MySQL host</label><input name="host" value="' . $v('host', 'localhost') . '" required>
<label>Database name</label><input name="dbname" value="' . $v('dbname') . '" required>
<label>Database user</label><input name="dbuser" value="' . $v('dbuser') . '" required>
<label>Database password</label><input name="dbpass" type="password">
<h3>Company &amp; admin</h3>
<label>Company name</label><input name="company" value="' . $v('company', 'Infraura') . '">
<label>Your name</label><input name="name" value="' . $v('name') . '" required>
<label>Admin email</label><input name="email" type="email" value="' . $v('email') . '" required>
<label>Admin password (min 8 chars)</label><input name="password" type="password" required minlength="8">
<button>Install</button></form>');
