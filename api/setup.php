<?php
declare(strict_types=1);
// Schema + seed data. Used only by install.php (blocked from web access by api/.htaccess).

function schema_sql(string $driver): array
{
    $pk = $driver === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'INT UNSIGNED AUTO_INCREMENT PRIMARY KEY';
    $long = $driver === 'sqlite' ? 'TEXT' : 'LONGTEXT';
    $eng = $driver === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
    return [
        "CREATE TABLE users (id $pk, name VARCHAR(120) NOT NULL, email VARCHAR(190) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL DEFAULT 'admin', created_at VARCHAR(19) NOT NULL)$eng",
        "CREATE TABLE settings (k VARCHAR(100) NOT NULL PRIMARY KEY, v $long)$eng",
        "CREATE TABLE clients (id $pk, name VARCHAR(190) NOT NULL, contact_person VARCHAR(120), phone VARCHAR(40), email VARCHAR(190), address TEXT, gstin VARCHAR(30), created_at VARCHAR(19) NOT NULL)$eng",
        "CREATE TABLE rate_items (id $pk, division VARCHAR(20) NOT NULL, category VARCHAR(120), name VARCHAR(255) NOT NULL, unit VARCHAR(30), rate DECIMAL(14,2) NOT NULL DEFAULT 0, description TEXT, active TINYINT NOT NULL DEFAULT 1, sort INT NOT NULL DEFAULT 0)$eng",
        "CREATE INDEX idx_rates_div ON rate_items (division)",
        "CREATE TABLE quotes (id $pk, quote_no VARCHAR(40) NOT NULL, rev INT NOT NULL DEFAULT 0, is_latest TINYINT NOT NULL DEFAULT 1, division VARCHAR(20) NOT NULL, client_id INT NULL, client_json $long, title VARCHAR(255), status VARCHAR(20) NOT NULL DEFAULT 'draft', quote_date VARCHAR(10), valid_until VARCHAR(10), data $long, subtotal DECIMAL(14,2) NOT NULL DEFAULT 0, discount DECIMAL(14,2) NOT NULL DEFAULT 0, tax DECIMAL(14,2) NOT NULL DEFAULT 0, round_off DECIMAL(14,2) NOT NULL DEFAULT 0, total DECIMAL(14,2) NOT NULL DEFAULT 0, created_by INT NULL, created_at VARCHAR(19) NOT NULL, updated_at VARCHAR(19) NOT NULL)$eng",
        "CREATE INDEX idx_quotes_no ON quotes (quote_no)",
        "CREATE INDEX idx_quotes_status ON quotes (status)",
    ];
}

function default_settings(string $company): array
{
    $t = default_terms();
    return [
        'company_name' => $company,
        'company_tagline' => 'Roofing • Interiors • Construction • PMC',
        'company_address' => '',
        'company_phone' => '',
        'company_email' => '',
        'company_gstin' => '',
        'company_logo' => '',
        'signatory' => '',
        'quote_prefix' => 'INF',
        'validity_days' => '15',
        'bank_details' => "Account Name: \nBank: \nAccount No: \nIFSC: \nBranch: ",
        'gst_roofing' => '18', 'gst_interior' => '18', 'gst_construction' => '18', 'gst_pmc' => '18',
        'terms_roofing' => $t['roofing'], 'terms_interior' => $t['interior'],
        'terms_construction' => $t['construction'], 'terms_pmc' => $t['pmc'],
        'pay_roofing' => "Advance with work order|50\nOn material delivery at site|40\nOn completion & handover|10",
        'pay_interior' => "Advance on confirmation|40\nOn carcass & material delivery|40\nOn completion & handover|20",
        'pay_construction' => "Advance on agreement|10\nOn foundation completion|20\nOn slab / structure completion|40\nOn finishing completion|20\nOn handover|10",
        'pay_pmc' => "On appointment|20\nOn completion of planning & tendering|20\nProgressive with work completion|50\nOn handover & closure|10",
    ];
}

function default_terms(): array
{
    return [
        'roofing' => "Rates are for supply and installation unless stated otherwise.\nQuantities are based on plan area; final billing is on actual measured area at site.\nFree access to site, water, power and a safe storage area to be provided by the client.\nScaffolding is included only where specifically mentioned.\nDelay due to weather, site readiness or client-side issues will extend the schedule.\nMaterial warranty is as per manufacturer terms; workmanship warranty is 1 year.\nAny work not mentioned in this quotation will be charged extra.",
        'interior' => "Quotation is based on the design / layout shared and may change with design revisions.\nMaterial brand and finish are as specified; any change will be charged at actuals.\nCivil, electrical and plumbing alterations are excluded unless mentioned.\nWork starts after the advance payment and design sign-off.\nStandard timeline begins after site is handed over free of obstructions.\nWarranty on carpentry workmanship is 1 year; hardware and appliances as per manufacturer.\nColours may vary slightly from samples due to production batches.",
        'construction' => "Quotation is based on the drawings and specifications shared at the time of quoting.\nRates are valid for the validity period; material price variation beyond 5% will be adjusted.\nExtra work or changes will be executed only on written approval at agreed rates.\nStatutory approvals, soil testing and utility connection charges are by the client unless stated.\nPayment milestones are to be cleared within 7 days of the bill.\nDefect liability period of 12 months from handover.\nAny work not mentioned in this quotation is excluded.",
        'pmc' => "Scope of services is as detailed in this quotation; services beyond scope will be charged separately.\nFees are exclusive of travel, statutory approval fees and third-party testing charges.\nFees are payable as per the payment schedule; delays beyond 7 days attract interest at 1.5% per month.\nProject cost basis for percentage fees will be the actual cost certified at project closure.\nClient will provide timely decisions, approvals and access to project documents.\nEither party may terminate with 30 days written notice; services rendered until then are payable.",
    ];
}

function seed_rate_items(): array
{
    // [division, category, name, unit, rate, description]  — INDICATIVE PLACEHOLDER RATES: edit to your actual costs.
    return [
        ['roofing', 'Roof Sheets', 'Colour coated profile sheet 0.45 mm TCT - supply & fixing', 'sq ft', 95, 'Trapezoidal profile, colour coated'],
        ['roofing', 'Roof Sheets', 'Colour coated profile sheet 0.50 mm TCT - supply & fixing', 'sq ft', 110, ''],
        ['roofing', 'Roof Sheets', 'Galvalume sheet 0.50 mm - supply & fixing', 'sq ft', 105, ''],
        ['roofing', 'Roof Sheets', 'Polycarbonate roofing sheet 2 mm - supply & fixing', 'sq ft', 135, ''],
        ['roofing', 'Roof Sheets', 'Translucent FRP skylight sheet - supply & fixing', 'sq ft', 120, ''],
        ['roofing', 'Roof Sheets', 'PUF insulated sandwich panel 50 mm - supply & fixing', 'sq ft', 260, ''],
        ['roofing', 'Structure', 'MS structural truss / rafter - fabrication & erection', 'kg', 92, ''],
        ['roofing', 'Structure', 'GI / MS purlins (Z / C) - supply & fixing', 'kg', 88, ''],
        ['roofing', 'Structure', 'Columns with base plates and grouting', 'kg', 95, ''],
        ['roofing', 'Structure', 'Primer + enamel paint to structural steel', 'sq ft', 18, ''],
        ['roofing', 'Accessories', 'Ridge cap / flashing (GI 0.5 mm)', 'rft', 180, ''],
        ['roofing', 'Accessories', 'Roof gutter (GI) with downtake pipe', 'rft', 320, ''],
        ['roofing', 'Accessories', 'Turbo ventilator 24 inch', 'nos', 4200, ''],
        ['roofing', 'Accessories', 'Ridge ventilator', 'rft', 450, ''],
        ['roofing', 'Accessories', 'Fasteners, J-bolts, washers & sealant', 'sq ft', 6, ''],
        ['roofing', 'Site Charges', 'Scaffolding & crane / hydra charges', 'lot', 25000, ''],
        ['roofing', 'Site Charges', 'Transportation & unloading', 'lot', 15000, ''],
        ['roofing', 'Site Charges', 'Dismantling of existing roof sheets', 'sq ft', 12, ''],

        ['interior', 'Kitchen', 'Modular kitchen - BWP ply carcass, laminate finish', 'sq ft', 1650, ''],
        ['interior', 'Kitchen', 'Modular kitchen - acrylic / PU finish', 'sq ft', 2400, ''],
        ['interior', 'Kitchen', 'Granite kitchen countertop with polish', 'rft', 1400, ''],
        ['interior', 'Wardrobes & Storage', 'Wardrobe - sliding door, laminate finish', 'sq ft', 1450, ''],
        ['interior', 'Wardrobes & Storage', 'Wardrobe - hinged shutters, BWP ply', 'sq ft', 1300, ''],
        ['interior', 'Wardrobes & Storage', 'Loft storage', 'sq ft', 950, ''],
        ['interior', 'Wardrobes & Storage', 'TV unit with back panel', 'sq ft', 1350, ''],
        ['interior', 'Wardrobes & Storage', 'Shoe rack', 'sq ft', 1100, ''],
        ['interior', 'False Ceiling', 'Gypsum false ceiling - plain', 'sq ft', 85, ''],
        ['interior', 'False Ceiling', 'Gypsum false ceiling with cove lighting', 'sq ft', 120, ''],
        ['interior', 'Walls & Paint', 'Interior emulsion paint - putty + 2 coats', 'sq ft', 28, ''],
        ['interior', 'Walls & Paint', 'Designer texture wall finish', 'sq ft', 75, ''],
        ['interior', 'Walls & Paint', 'Wall paneling (wood / WPC)', 'sq ft', 220, ''],
        ['interior', 'Walls & Paint', 'Wallpaper - supply & fixing', 'sq ft', 90, ''],
        ['interior', 'Flooring', 'Vitrified tile flooring - supply & laying', 'sq ft', 95, ''],
        ['interior', 'Flooring', 'Laminate wooden flooring', 'sq ft', 140, ''],
        ['interior', 'Electrical & Lighting', 'Electrical point (light / fan / socket) wiring', 'nos', 850, ''],
        ['interior', 'Electrical & Lighting', 'Profile / COB light fitting', 'nos', 650, ''],
        ['interior', 'Electrical & Lighting', 'Decorative chandelier - supply & hanging (allowance)', 'nos', 12000, ''],
        ['interior', 'Furnishing', 'Curtains with track - per window', 'nos', 7500, ''],
        ['interior', 'Furnishing', 'Roller / zebra blinds', 'sq ft', 160, ''],
        ['interior', 'Bath', 'Vanity unit with mirror', 'nos', 14500, ''],

        ['construction', 'Earthwork', 'Excavation in all soils', 'cum', 380, ''],
        ['construction', 'Earthwork', 'Backfilling & compaction', 'cum', 220, ''],
        ['construction', 'Earthwork', 'Anti-termite treatment', 'sq ft', 12, ''],
        ['construction', 'Concrete', 'PCC 1:4:8', 'cum', 5800, ''],
        ['construction', 'Concrete', 'RCC M25 - supply, place & cure (excl. steel)', 'cum', 8200, ''],
        ['construction', 'Concrete', 'Shuttering & centering', 'sq ft', 95, ''],
        ['construction', 'Steel', 'TMT reinforcement Fe500D - supply, cut, bend & tie', 'kg', 78, ''],
        ['construction', 'Masonry', 'Brick masonry 230 mm', 'cum', 7200, ''],
        ['construction', 'Masonry', 'AAC block masonry 200 mm', 'cum', 6200, ''],
        ['construction', 'Finishing', 'Internal cement plaster 12 mm', 'sq ft', 38, ''],
        ['construction', 'Finishing', 'External cement plaster 20 mm', 'sq ft', 48, ''],
        ['construction', 'Finishing', 'Vitrified tile flooring', 'sq ft', 110, ''],
        ['construction', 'Finishing', 'Terrace waterproofing', 'sq ft', 85, ''],
        ['construction', 'Finishing', 'Internal painting - putty + 2 coats', 'sq ft', 24, ''],
        ['construction', 'Finishing', 'External weatherproof painting', 'sq ft', 32, ''],
        ['construction', 'Doors & Windows', 'Main teak door with frame', 'nos', 38000, ''],
        ['construction', 'Doors & Windows', 'Flush door with frame', 'nos', 12500, ''],
        ['construction', 'Doors & Windows', 'UPVC / aluminium window', 'sq ft', 480, ''],
        ['construction', 'MEP', 'Concealed electrical wiring - per point', 'nos', 900, ''],
        ['construction', 'MEP', 'Plumbing & sanitary - per bathroom', 'nos', 38000, ''],
        ['construction', 'Turnkey', 'Turnkey construction - grey structure', 'sq ft', 1750, 'Per sq ft of built-up area'],
        ['construction', 'Turnkey', 'Turnkey construction - with finishing', 'sq ft', 2400, 'Per sq ft of built-up area'],

        ['pmc', 'Fees', 'Project management consultancy fee (% of project cost)', '%', 4, ''],
        ['pmc', 'Fees', 'Monthly PMC retainer', 'month', 85000, ''],
        ['pmc', 'Fees', 'PMC fee per sq ft of built-up area', 'sq ft', 60, ''],
        ['pmc', 'Resources', 'Full-time site engineer', 'month', 45000, ''],
        ['pmc', 'Resources', 'Quantity surveying & RA bill verification', 'month', 25000, ''],
        ['pmc', 'Resources', 'Design coordination', 'month', 30000, ''],
        ['pmc', 'Services', 'Planning & scheduling (baseline + monitoring)', 'lot', 60000, ''],
        ['pmc', 'Services', 'Vendor / tender evaluation', 'lot', 40000, ''],
        ['pmc', 'Services', 'Quality audit visit', 'visit', 8000, ''],
        ['pmc', 'Services', 'Handover & snag list management', 'lot', 35000, ''],
    ];
}

function install_database(PDO $pdo, string $driver, string $company, string $adminName, string $adminEmail, string $adminPassword): void
{
    foreach (schema_sql($driver) as $sql) {
        $pdo->exec($sql);
    }
    $now = date('Y-m-d H:i:s');
    $st = $pdo->prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)');
    $st->execute([$adminName, strtolower($adminEmail), password_hash($adminPassword, PASSWORD_DEFAULT), 'admin', $now]);

    $st = $pdo->prepare('INSERT INTO settings (k,v) VALUES (?,?)');
    foreach (default_settings($company) as $k => $v) {
        $st->execute([$k, $v]);
    }
    $st = $pdo->prepare('INSERT INTO rate_items (division,category,name,unit,rate,description,active,sort) VALUES (?,?,?,?,?,?,1,?)');
    foreach (seed_rate_items() as $i => $r) {
        $st->execute([$r[0], $r[1], $r[2], $r[3], $r[4], $r[5], $i]);
    }
}
