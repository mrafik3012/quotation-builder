<?php
declare(strict_types=1);
// Lightweight forward-only migrations. Runs automatically (once per version) on the first signed-in request,
// so already-installed sites upgrade just by uploading the new files.

const SCHEMA_VERSION = 4;

function ensure_schema(): void
{
    static $done = false;
    if ($done) return;
    $done = true;
    $cur = (int)(get_setting('schema_v') ?? 0);
    if ($cur >= SCHEMA_VERSION) return;
    $sqlite = (config()['driver'] ?? 'mysql') === 'sqlite';
    $pk = $sqlite ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'INT UNSIGNED AUTO_INCREMENT PRIMARY KEY';
    $long = $sqlite ? 'TEXT' : 'LONGTEXT';
    $eng = $sqlite ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';

    if ($cur < 1) {
        // cost price on rate items (for margin tracking) + reusable quote templates
        if (!column_exists('rate_items', 'cost')) {
            db()->exec('ALTER TABLE rate_items ADD COLUMN cost DECIMAL(14,2) NOT NULL DEFAULT 0');
            db()->exec('UPDATE rate_items SET cost = ROUND(rate * 0.8, 2) WHERE cost = 0');
        }
        db()->exec("CREATE TABLE IF NOT EXISTS quote_templates (id $pk, name VARCHAR(190) NOT NULL, division VARCHAR(20) NOT NULL, data $long, created_at VARCHAR(19) NOT NULL)$eng");
        if ((int)q('SELECT COUNT(*) AS n FROM quote_templates')->fetch()['n'] === 0) seed_templates();
        if (get_setting('min_margin') === null) set_setting('min_margin', '15');
    }
    if ($cur < 2) {
        // client share links + activity log (views, accept / reject with e-signature)
        db()->exec("CREATE TABLE IF NOT EXISTS quote_shares (id $pk, quote_no VARCHAR(40) NOT NULL UNIQUE, token VARCHAR(48) NOT NULL UNIQUE, created_at VARCHAR(19) NOT NULL)$eng");
        db()->exec("CREATE TABLE IF NOT EXISTS quote_events (id $pk, quote_no VARCHAR(40) NOT NULL, rev INT NOT NULL DEFAULT 0, type VARCHAR(20) NOT NULL, detail $long, actor VARCHAR(190), ip VARCHAR(45), created_at VARCHAR(19) NOT NULL)$eng");
        db()->exec('CREATE INDEX idx_events_no ON quote_events (quote_no)');
        foreach (['roofing' => '9954', 'interior' => '9954', 'construction' => '9954', 'pmc' => '9983'] as $k => $v) {
            if (get_setting('hsn_' . $k) === null) set_setting('hsn_' . $k, $v);
        }
    }
    if ($cur < 3) {
        // projects created from accepted quotes: billing milestones, receipts, variation orders, site log
        db()->exec("CREATE TABLE IF NOT EXISTS projects (id $pk, quote_no VARCHAR(40) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL, client_id INT NULL, division VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'active', base_value DECIMAL(14,2) NOT NULL DEFAULT 0, tax_rate DECIMAL(6,2) NOT NULL DEFAULT 18, start_date VARCHAR(10), end_date VARCHAR(10), notes TEXT, created_at VARCHAR(19) NOT NULL)$eng");
        db()->exec("CREATE TABLE IF NOT EXISTS project_milestones (id $pk, project_id INT NOT NULL, label VARCHAR(190) NOT NULL, percent DECIMAL(7,3) NOT NULL DEFAULT 0, amount DECIMAL(14,2) NOT NULL DEFAULT 0, due_date VARCHAR(10), invoice_no VARCHAR(40), invoice_date VARCHAR(10), kind VARCHAR(12) NOT NULL DEFAULT 'stage', sort INT NOT NULL DEFAULT 0)$eng");
        db()->exec("CREATE TABLE IF NOT EXISTS project_receipts (id $pk, project_id INT NOT NULL, milestone_id INT NULL, amount DECIMAL(14,2) NOT NULL, received_on VARCHAR(10) NOT NULL, mode VARCHAR(30), reference VARCHAR(120), note VARCHAR(255), created_at VARCHAR(19) NOT NULL)$eng");
        db()->exec("CREATE TABLE IF NOT EXISTS project_variations (id $pk, project_id INT NOT NULL, title VARCHAR(255) NOT NULL, note TEXT, amount DECIMAL(14,2) NOT NULL DEFAULT 0, status VARCHAR(12) NOT NULL DEFAULT 'proposed', milestone_id INT NULL, created_at VARCHAR(19) NOT NULL)$eng");
        db()->exec("CREATE TABLE IF NOT EXISTS project_log (id $pk, project_id INT NOT NULL, log_date VARCHAR(10) NOT NULL, text TEXT, progress INT NULL, author VARCHAR(120), created_at VARCHAR(19) NOT NULL)$eng");
        db()->exec('CREATE INDEX idx_pm_proj ON project_milestones (project_id)');
        db()->exec('CREATE INDEX idx_pr_proj ON project_receipts (project_id)');
    }
    if ($cur < 4) {
        db()->exec("CREATE TABLE IF NOT EXISTS audit_log (id $pk, user_name VARCHAR(120), action VARCHAR(40) NOT NULL, detail VARCHAR(500), created_at VARCHAR(19) NOT NULL)$eng");
    }
    set_setting('schema_v', (string)SCHEMA_VERSION);
}

function column_exists(string $table, string $col): bool
{
    $sqlite = (config()['driver'] ?? 'mysql') === 'sqlite';
    if ($sqlite) {
        foreach (db()->query("PRAGMA table_info($table)")->fetchAll() as $r) if ($r['name'] === $col) return true;
        return false;
    }
    return (bool)q('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [$table, $col])->fetch();
}

function seed_templates(): void
{
    $it = fn($d, $u, $qty, $rate) => ['desc' => $d, 'unit' => $u, 'qty' => $qty, 'rate' => $rate, 'cost' => round($rate * 0.8, 2), 'note' => ''];
    $T = [
        ['Industrial shed re-roofing (GI)', 'roofing', [['title' => 'Roofing Works', 'items' => [
            $it('Dismantling of existing roof sheets', 'sq ft', 5000, 12),
            $it('Colour coated profile sheet 0.50 mm TCT - supply & fixing', 'sq ft', 5000, 110),
            $it('Ridge cap flashing (PPGI)', 'rft', 100, 185),
            $it('Turbo ventilator 24 inch (aluminium, with base)', 'nos', 5, 4500),
            $it('Fasteners, J-bolts, washers & sealant', 'sq ft', 5000, 6),
            $it('Scaffolding & crane / hydra charges', 'lot', 1, 25000)]]]],
        ['PUF panel roof - cold storage / factory', 'roofing', [['title' => 'Roofing Works', 'items' => [
            $it('PUF sandwich panel 50 mm - supply & fixing', 'sq ft', 4000, 270),
            $it('PUF panel corner / cap / base channel flashing', 'rft', 300, 210),
            $it('GI / MS purlins (Z / C) - supply & fixing', 'kg', 6000, 88),
            $it('Scaffolding & crane / hydra charges', 'lot', 1, 35000)]]]],
        ['2 BHK interior package', 'interior', [
            ['title' => 'Kitchen', 'items' => [$it('Modular kitchen - L-shaped, BWP ply carcass', 'sq ft', 90, 1800), $it('Quartz / engineered stone countertop', 'rft', 14, 2800)]],
            ['title' => 'Bedrooms & Living', 'items' => [$it('Wardrobe - sliding door, laminate finish', 'sq ft', 70, 1450), $it('TV unit with back panel', 'sq ft', 30, 1350), $it('Gypsum false ceiling with peripheral cove', 'sq ft', 900, 130)]],
            ['title' => 'Finishes', 'items' => [$it('Interior premium emulsion (Royale type) - 2 coats', 'sq ft', 3200, 36), $it('Concealed conduit & wiring - per point', 'nos', 40, 950)]]]],
        ['Residential turnkey - 1500 sq ft', 'construction', [['title' => 'Construction Works', 'items' => [
            $it('Turnkey construction - with finishing', 'sq ft', 1500, 2400),
            $it('Terrace waterproofing - APP membrane', 'sq ft', 750, 110),
            $it('Building plan approval & statutory fees (allowance)', 'lot', 1, 65000)]]]],
        ['Residential PMC - 12 months', 'pmc', [['title' => 'PMC Services', 'items' => [
            $it('Resident engineer - on-site (full time)', 'month', 12, 65000),
            $it('Billing / QS engineer', 'month', 12, 42000),
            $it('Quality audit visit - structural works', 'visit', 6, 9000),
            $it('Pre-handover inspection & snagging', 'lot', 1, 45000)]]]],
    ];
    foreach ($T as [$name, $div, $secs]) {
        q('INSERT INTO quote_templates (name,division,data,created_at) VALUES (?,?,?,?)', [$name, $div, json_encode(['sections' => $secs], JSON_UNESCAPED_UNICODE), now()]);
    }
}
