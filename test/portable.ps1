param([Parameter(Mandatory = $true)][string]$Release)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$releasePath = (Resolve-Path -LiteralPath $Release).Path
if (!$releasePath.StartsWith((Join-Path $project 'release') + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)) { throw 'Select a build under the project release directory.' }

$buildExe = Join-Path $releasePath 'FeinChat.exe'
if (Test-Path -LiteralPath (Join-Path $releasePath 'data')) { throw 'Use a clean release without data.' }
$headers = [IO.File]::ReadAllBytes($buildExe)
$nt = [BitConverter]::ToInt32($headers, 60)
if ([BitConverter]::ToUInt16($headers, $nt + 4) -ne 0x8664) { throw 'Expected Windows x64.' }
if ([BitConverter]::ToUInt16($headers, $nt + 92) -ne 2) { throw 'Expected the Windows GUI subsystem.' }
if ((Get-Item -LiteralPath $buildExe).VersionInfo.ProductName -ne 'FeinChat') { throw 'Incorrect executable metadata.' }

$tmp = Join-Path $project '.cache\tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:TEMP = $env:TMP = $tmp
$fixture = Join-Path $tmp ('portable-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$first = Join-Path $fixture 'First location'
$relocated = Join-Path $fixture 'Перенесённая копия'
Copy-Item -LiteralPath $releasePath -Destination $first -Recurse

function Launch-And-Close([string]$Directory) {
    $exe = Join-Path $Directory 'FeinChat.exe'
    $start = [Diagnostics.ProcessStartInfo]::new($exe)
    $start.UseShellExecute = $false
    $start.WorkingDirectory = $fixture
    $child = [Diagnostics.Process]::Start($start)
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            $child.Refresh()
            if ($child.HasExited) { throw "FeinChat quit with $($child.ExitCode)." }
            if ($child.MainWindowTitle -eq 'FeinChat') { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($child.MainWindowTitle -ne 'FeinChat') { throw 'FeinChat window did not appear.' }
        foreach ($name in 'feinchat.sqlite3', 'chromium', 'session', 'crashes', 'logs', 'tmp') {
            if (!(Test-Path -LiteralPath (Join-Path $Directory "data\$name"))) { throw "Missing data\$name." }
        }
        if (!$child.CloseMainWindow() -or !$child.WaitForExit(10000) -or $child.ExitCode -ne 0) {
            throw 'FeinChat did not quit cleanly.'
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $remaining = @(Get-Process -Name FeinChat -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
            if (!$remaining.Count) { return }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)
        throw 'FeinChat process remained after closing the window.'
    } finally {
        if (!$child.HasExited) { Stop-Process -Id $child.Id -Force }
    }
}

Push-Location -LiteralPath $project
try {
    Launch-And-Close $first
    $seed = @'
const {openStore} = require('./electron/store.cjs');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const db = openStore(process.argv[1]);
assert.equal(db.snapshot().chats.length, 0);
assert.equal(db.snapshot().providers.length, 0);
db.setTheme('dark');
db.saveProvider({id: null, name: 'Portable fixture', baseUrl: 'https://fixture.example', apiKey: 'fixture-key',
  model: 'fixture/model', temperature: null, maxTokens: null});
db.createChat();
const chat = db.snapshot().chat;
db.renameChat(chat.id, 'Relocated history');
db.pinChat(chat.id, true);
const completed = db.beginGeneration(chat, {mode: 'send', tailId: null, text: 'Earlier portable context'});
db.finishGeneration({...completed, text: 'Earlier portable answer', usage: {
  inputTokens: 7, outputTokens: 5, totalTokens: 12, cost: 0.004, currency: 'USD',
}}, 'done', null);
const job = db.beginGeneration(chat, {mode: 'send', tailId: completed.messageId, text: 'Portable context'});
db.saveProgress(job.messageId, 'Saved partial');
db.close();
// Emulate the prior schema without changing any real user database.
const legacy = new DatabaseSync(process.argv[1]);
legacy.exec('ALTER TABLE chats DROP COLUMN temperatureOverride; ALTER TABLE chats DROP COLUMN maxTokensOverride; PRAGMA user_version = 2;');
legacy.close();
'@
    node -e $seed (Join-Path $first 'data\feinchat.sqlite3')
    if ($LASTEXITCODE -ne 0) { throw 'Could not seed the isolated relocation fixture.' }
    Launch-And-Close $first
    $upgrade = @'
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {openStore} = require('./electron/store.cjs');
const legacy = new DatabaseSync(process.argv[1], {readOnly: true});
assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 3);
const parameters = legacy.prepare('SELECT temperatureOverride, maxTokensOverride FROM chats').get();
assert.equal(parameters.temperatureOverride, null);
assert.equal(parameters.maxTokensOverride, null);
legacy.close();
const db = openStore(process.argv[1]);
const chat = db.snapshot().chat;
assert.equal(chat.messages.at(-1).text, 'Saved partial');
assert.equal(chat.messages.at(-1).status, 'interrupted');
db.applyProvider(chat.id, chat.providerId, chat.model, {temperature: 0, maxTokens: 1234});
db.close();
'@
    node -e $upgrade (Join-Path $first 'data\feinchat.sqlite3')
    if ($LASTEXITCODE -ne 0) { throw 'The packaged app failed to upgrade the previous schema.' }
    Copy-Item -LiteralPath $first -Destination $relocated -Recurse
    Launch-And-Close $relocated
    $verify = @'
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], {readOnly: true});
assert.equal(db.prepare('SELECT name FROM chats').get().name, 'Relocated history');
assert.equal(db.prepare('SELECT pinned FROM chats').get().pinned, 1);
assert.equal(db.prepare('SELECT model FROM chats').get().model, 'fixture/model');
assert.equal(db.prepare('SELECT apiKey FROM providers').get().apiKey, 'fixture-key');
assert.equal(db.prepare('SELECT count(*) AS count FROM messages').get().count, 4);
assert.deepEqual(db.prepare('SELECT text FROM messages ORDER BY id').all().map(row => row.text),
  ['Earlier portable context', 'Earlier portable answer', 'Portable context', 'Saved partial']);
assert.equal(db.prepare('SELECT totalTokens FROM requests WHERE totalTokens IS NOT NULL').get().totalTokens, 12);
assert.equal(db.prepare('SELECT cost FROM requests WHERE cost IS NOT NULL').get().cost, 0.004);
const parameters = db.prepare('SELECT temperatureOverride, maxTokensOverride FROM chats').get();
assert.equal(parameters.temperatureOverride, 0);
assert.equal(parameters.maxTokensOverride, 1234);
const row = db.prepare('SELECT text, status FROM messages ORDER BY id DESC LIMIT 1').get();
assert.equal(row.text, 'Saved partial');
assert.equal(row.status, 'interrupted');
assert.equal(db.prepare('SELECT theme FROM appearance WHERE id = 1').get().theme, 'dark');
db.close();
'@
    node -e $verify (Join-Path $relocated 'data\feinchat.sqlite3')
    if ($LASTEXITCODE -ne 0) { throw 'Relocated data failed verification.' }
    if (Test-Path -LiteralPath (Join-Path $fixture 'data')) { throw 'FeinChat used the current working directory.' }
    Write-Output 'Portable x64 GUI, clean first start, prior-schema upgrade, relocation with keys/history/usage and process exit passed.'
    Write-Output $fixture
} finally {
    Pop-Location
}
