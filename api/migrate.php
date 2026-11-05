<?php
declare(strict_types=1);
// Lightweight forward-only migrations. Runs automatically (once per version) on the first signed-in request,
// so already-installed sites upgrade just by uploading the new files.

const SCHEMA_VERSION = 9;

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
            ddl('ALTER TABLE rate_items ADD COLUMN cost DECIMAL(14,2) NOT NULL DEFAULT 0');
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
        ddl('CREATE INDEX idx_events_no ON quote_events (quote_no)');
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
        ddl('CREATE INDEX idx_pm_proj ON project_milestones (project_id)');
        ddl('CREATE INDEX idx_pr_proj ON project_receipts (project_id)');
    }
    if ($cur < 4) {
        db()->exec("CREATE TABLE IF NOT EXISTS audit_log (id $pk, user_name VARCHAR(120), action VARCHAR(40) NOT NULL, detail VARCHAR(500), created_at VARCHAR(19) NOT NULL)$eng");
    }
    if ($cur < 5) {
        ddl("CREATE TABLE IF NOT EXISTS rate_limits (k VARCHAR(80) NOT NULL PRIMARY KEY, hits INT NOT NULL DEFAULT 0, window_start INT NOT NULL DEFAULT 0)$eng");
        // a quote number + revision must be unique (guards against two people saving at the same instant)
        ddl('CREATE UNIQUE INDEX uq_quote_no_rev ON quotes (quote_no, rev)');
    }
    if ($cur < 6) {
        // API tokens for AI assistants / integrations (MCP). Only a SHA-256 hash of the token is stored.
        ddl("CREATE TABLE IF NOT EXISTS api_tokens (id $pk, name VARCHAR(120) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE, prefix VARCHAR(16) NOT NULL, scope VARCHAR(10) NOT NULL DEFAULT 'read', hide_costs TINYINT NOT NULL DEFAULT 1, user_id INT NULL, last_used_at VARCHAR(19), expires_at VARCHAR(19), revoked TINYINT NOT NULL DEFAULT 0, created_at VARCHAR(19) NOT NULL)$eng");
    }
    if ($cur < 7) {
        // --- accounts: 2FA, forced password change, password-reset tokens
        foreach (['totp_secret VARCHAR(64) NULL', 'totp_enabled TINYINT NOT NULL DEFAULT 0', 'totp_last INT NOT NULL DEFAULT 0', 'recovery_codes TEXT NULL', 'must_change_password TINYINT NOT NULL DEFAULT 0'] as $def) {
            if (!column_exists('users', explode(' ', $def)[0])) ddl('ALTER TABLE users ADD COLUMN ' . $def);
        }
        ddl("CREATE TABLE IF NOT EXISTS password_resets (id $pk, user_id INT NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE, expires_at VARCHAR(19) NOT NULL, used TINYINT NOT NULL DEFAULT 0, created_at VARCHAR(19) NOT NULL)$eng");
        // --- e-mail log + settings
        ddl("CREATE TABLE IF NOT EXISTS email_log (id $pk, recipient VARCHAR(190) NOT NULL, subject VARCHAR(255), status VARCHAR(12) NOT NULL, error VARCHAR(500), created_at VARCHAR(19) NOT NULL)$eng");
        foreach (['smtp_host' => '', 'smtp_port' => '465', 'smtp_enc' => 'ssl', 'smtp_user' => '', 'smtp_pass' => '', 'mail_from' => '', 'mail_from_name' => '', 'client_reminders' => '0', 'oauth_enabled' => '1', 'backup_keep' => '14', 'cron_last_run' => '', 'cron_key' => bin2hex(random_bytes(16))] as $k => $v) {
            if (get_setting($k) === null) set_setting($k, $v);
        }
        // --- invoicing: cancel, credit notes, receipts, e-invoice references
        foreach (['irn VARCHAR(80) NULL', 'ack_no VARCHAR(40) NULL', 'ack_date VARCHAR(10) NULL'] as $def) {
            if (!column_exists('project_milestones', explode(' ', $def)[0])) ddl('ALTER TABLE project_milestones ADD COLUMN ' . $def);
        }
        if (!column_exists('project_receipts', 'receipt_no')) ddl('ALTER TABLE project_receipts ADD COLUMN receipt_no VARCHAR(40) NULL');
        ddl("CREATE TABLE IF NOT EXISTS invoice_history (id $pk, project_id INT NOT NULL, milestone_id INT NOT NULL, invoice_no VARCHAR(40) NOT NULL, invoice_date VARCHAR(10), amount DECIMAL(14,2) NOT NULL DEFAULT 0, status VARCHAR(12) NOT NULL, reason VARCHAR(255), created_at VARCHAR(19) NOT NULL)$eng");
        ddl("CREATE TABLE IF NOT EXISTS credit_notes (id $pk, project_id INT NOT NULL, milestone_id INT NOT NULL, credit_no VARCHAR(40) NOT NULL, credit_date VARCHAR(10) NOT NULL, amount DECIMAL(14,2) NOT NULL, reason VARCHAR(255), created_at VARCHAR(19) NOT NULL)$eng");
        // --- AMC / warranty renewals, site-log photos
        foreach (['amc_end VARCHAR(10) NULL', 'amc_note VARCHAR(255) NULL'] as $def) { if (!column_exists('projects', explode(' ', $def)[0])) ddl('ALTER TABLE projects ADD COLUMN ' . $def); }
        if (!column_exists('project_log', 'photos')) ddl("ALTER TABLE project_log ADD COLUMN photos $long NULL");
        // --- privacy
        if (!column_exists('clients', 'anonymized')) ddl('ALTER TABLE clients ADD COLUMN anonymized TINYINT NOT NULL DEFAULT 0');
        // --- performance for large data sets
        foreach (['CREATE INDEX idx_q_latest ON quotes (is_latest, status)', 'CREATE INDEX idx_q_client ON quotes (client_id)', 'CREATE INDEX idx_q_upd ON quotes (updated_at)', 'CREATE INDEX idx_q_no ON quotes (quote_no)',
                  'CREATE INDEX idx_ev_type ON quote_events (quote_no, type)', 'CREATE INDEX idx_pl_proj ON project_log (project_id)', 'CREATE INDEX idx_pv_proj ON project_variations (project_id)', 'CREATE INDEX idx_rc_ms ON project_receipts (milestone_id)',
                  'CREATE INDEX idx_cn_proj ON credit_notes (project_id)', 'CREATE INDEX idx_audit_id ON audit_log (created_at)'] as $sql) ddl($sql);
        // --- OAuth 2.1 for MCP connectors (claude.ai etc.)
        ddl("CREATE TABLE IF NOT EXISTS oauth_clients (client_id VARCHAR(64) NOT NULL PRIMARY KEY, name VARCHAR(190) NOT NULL, redirect_uris $long, created_at VARCHAR(19) NOT NULL)$eng");
        ddl("CREATE TABLE IF NOT EXISTS oauth_codes (code_hash CHAR(64) NOT NULL PRIMARY KEY, client_id VARCHAR(64) NOT NULL, user_id INT NOT NULL, scope VARCHAR(10) NOT NULL, hide_costs TINYINT NOT NULL DEFAULT 1, redirect_uri VARCHAR(500) NOT NULL, code_challenge VARCHAR(128) NOT NULL, grant_id VARCHAR(32) NOT NULL, expires_at INT NOT NULL, used TINYINT NOT NULL DEFAULT 0)$eng");
        ddl("CREATE TABLE IF NOT EXISTS oauth_refresh (token_hash CHAR(64) NOT NULL PRIMARY KEY, client_id VARCHAR(64) NOT NULL, user_id INT NOT NULL, scope VARCHAR(10) NOT NULL, hide_costs TINYINT NOT NULL DEFAULT 1, grant_id VARCHAR(32) NOT NULL, expires_at INT NOT NULL, revoked TINYINT NOT NULL DEFAULT 0)$eng");
        foreach (['oauth_client VARCHAR(64) NULL', 'grant_id VARCHAR(32) NULL'] as $def) { if (!column_exists('api_tokens', explode(' ', $def)[0])) ddl('ALTER TABLE api_tokens ADD COLUMN ' . $def); }
    }
    if ($cur < 8) {
        // automation switches (defaults: the safe, helpful ones on; anything that e-mails clients beyond a confirmation stays opt-in)
        foreach (['auto_jobs' => '1', 'auto_jobs_at' => '0', 'notify_events' => '1', 'confirm_client' => '1', 'auto_project' => '1', 'overdue_reminders' => '0', 'setup_dismissed' => '0', 'rates_reviewed' => '0'] as $k => $v) {
            if (get_setting($k) === null) set_setting($k, $v);
        }
    }
    if ($cur < 9) {
        // client-approved change orders + price factors for quick quotes
        foreach (['approval_token VARCHAR(32) NULL', 'decided_by VARCHAR(120) NULL', 'decided_at VARCHAR(19) NULL', 'decided_ip VARCHAR(45) NULL', 'client_note VARCHAR(500) NULL'] as $def) {
            if (!column_exists('project_variations', explode(' ', $def)[0])) ddl('ALTER TABLE project_variations ADD COLUMN ' . $def);
        }
        ddl('CREATE INDEX idx_pv_token ON project_variations (approval_token)');
        if (get_setting('price_factors') === null) set_setting('price_factors', "Metro (Mumbai / Delhi / Bengaluru / Hyderabad / Chennai)|12\nTier-2 city|0\nSmaller town|-8");
    }
    set_setting('schema_v', (string)SCHEMA_VERSION);
}

/** Run a DDL statement, tolerating "already exists" (two first requests can race during an upgrade). */
function ddl(string $sql): void
{
    try { db()->exec($sql); }
    catch (PDOException $e) {
        $m = strtolower($e->getMessage());
        if (strpos($m, 'already exists') === false && strpos($m, 'duplicate') === false) error_log('migration warning: ' . $e->getMessage());
    }
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
