/**
 * ELE TRACKER — BACKEND (Code.gs)
 *
 * Apps Script backend for the Winding-to-Final-QA batch card: nine stages —
 * Winding, Spray, Heat Stabilization, Short Clearing, Welding, Pouring &
 * Curing, Electrical Testing & Packing, BDV & Final Testing, Final QA —
 * tracked under one MasterBatchNo in BatchMaster, which moves forward one
 * CurrentStage at a time as each stage logs its entry.
 *
 * Bound to the ELE spreadsheet (Extensions → Apps Script) and deployed as a
 * Web App. doPost is the only entry point the frontend calls; see API
 * ROUTING near the bottom.
 *
 * There is no login here. Every request is validated against Stock
 * Management's Sessions sheet (see AUTH), the same pattern Manufacturing
 * Tracker uses, so one sign-in covers the whole app family.
 *
 * Every write runs under a single script lock per request (see WRITE LOCK).
 * A stage's "is this batch at the right prior stage" check and the write
 * that depends on it therefore can't interleave with another device's
 * submission for the same batch. A write that carries a clientTxnId is
 * recorded against it, so a resend after a lost reply gets the first
 * answer back instead of saving twice (see IDEMPOTENCY).
 *
 * The mid-chain stages, Spray through BDV, share one shape — look the batch
 * up, confirm its prior stage, log the entry, advance — factored into
 * getBatchRow_ / requireStage_ / advanceStage_, so each stage states only
 * what is its own: its sheet, its fields, and its prior and next stages.
 *
 * Operator lists are one Dropdowns column per stage (Operators_Winding,
 * Operators_Spray, …). Short Clearing carries four Retest* fields for the
 * card's separate "Retesting (If Required)" block. A legacy 'Staff' column
 * may still exist on the Dropdowns tab; nothing reads it.
 */

// ============================================================
// CONFIG
// ============================================================

// Stock Management's spreadsheet — Sessions/Users/Departments live there;
// ELE Tracker has no login or user table of its own.
var STOCK_SHEET_ID = '1iCFlMmzjhBiMsS47ahy56gm35LZc1GidJP5yVPnYAbc';

// Actions callable without a valid session token.
var PUBLIC_ACTIONS = ['ping'];

// How long a write waits for another device's write to finish. Kept under
// the frontend's 30s request timeout, so a busy system answers with a clear
// "try again" instead of the client giving up with no answer at all.
var WRITE_LOCK_WAIT_MS = 20000;

// Each stage's entry form is one permission, named after the stage. Who may
// use it is decided in two places: Stock Management's Team & Access grants
// "record your department's stages" (or "any stage"), and the Stage_Access
// tab here says which departments each stage belongs to.
var STAGE_PERMISSIONS = {
  enterWinding: 'Winding',
  enterSpray: 'Spray & Core Cleaning',
  enterHeatStab: 'Heat Stabilization',
  enterShortClearing: 'Short Clearing',
  enterWelding: 'Welding & Soldering',
  enterPouringCuring: 'Pouring & Curing',
  enterElectricalPacking: 'Electrical Testing & Packing',
  enterBDV: 'BDV & Final Testing',
  enterFinalQA: 'Final QA'
};

// The stages are ELE's own process steps; the departments are Stock
// Management's (its Departments tab). Setup writes these into the
// Stage_Access tab once; after that the tab is edited, never overwritten.
// A stage the tab doesn't list falls back to its entry here.
var STAGE_ACCESS_DEFAULT = [
  ['Winding',                      'Winding'],
  ['Spray & Core Cleaning',        'Spray'],
  ['Heat Stabilization',           'Spray'],
  ['Short Clearing',               'Short Clearance'],
  ['Welding & Soldering',          'Assembly-MFD, Assembly-kVAr'],
  ['Pouring & Curing',             'Assembly-MFD, Assembly-kVAr'],
  ['Electrical Testing & Packing', 'Assembly-MFD, Assembly-kVAr'],
  ['BDV & Final Testing',          'QA'],
  ['Final QA',                     'QA']
];

var CODE_SEQUENCES_HEADERS = ['Key', 'Prefix', 'FY', 'LastNumber'];

// How many of the newest rows a get…Entries read returns when the app
// doesn't say. The lists load every 45 seconds on every open device, so
// they must not grow with the sheet for ever. A batch's own report reads
// all its rows (getBatchRecord), whatever its age.
var ENTRIES_DEFAULT_LIMIT = 2000;
var ENTRIES_MAX_LIMIT = 10000;

// Duplicate protection: how far back a resent clientTxnId is looked for.
// A resend comes seconds or minutes after the original, so the newest
// rows are enough and the check stays fast as the tab grows.
var IDEMPOTENCY_TAB = 'Idempotency';
var IDEMPOTENCY_SCAN_ROWS = 2000;

// A voided entry stays in its tab, marked with these, so the record of
// what was entered and who took it back is never lost.
var VOID_COLUMNS = ['Voided', 'VoidedBy', 'VoidedAt', 'VoidReason'];

// Every tab this project owns, with headers — used by ADMIN_setupSheet
// (bottom of file) to create any tab that's missing. Safe to leave here
// even though the sheet is already set up: re-running it is a no-op.
var ELE_TAB_SCHEMA = {
  'Dropdowns': [
    'Machines_Winding', 'Machines_Spray', 'Machines_HeatStab', 'Machines_ShortClearing',
    'Machines_Welding', 'Machines_PouringCuring', 'Machines_ElectricalPacking', 'Machines_BDV',
    'Shifts', 'FilmType', 'FreeMargin', 'Resistivity', 'CanSize',
    'AssemblyDeltaWireType', 'MetalTopConnection', 'ProcessTimeOptions', 'CoolingTimeOptions',
    'FilmUsedFor', 'FilmSupplier', 'FilmTypeShortCode', 'CustomerNames',
    'Operators_Winding', 'Operators_Spray', 'Operators_HeatStab', 'Operators_ShortClearing',
    'Operators_Welding', 'Operators_PouringCuring', 'Operators_ElectricalPacking', 'Operators_BDV', 'Operators_FinalQA'
  ],
  'BatchMaster': [
    'MasterBatchNo', 'WindingProgramNo', 'CycleTime', 'DrawingNo', 'FGCode', 'ElementBatchNo',
    'DatePlanning', 'MFD', 'Voltage', 'CustomerName', 'BatchQty', 'FilmBatchNo',
    'InputMaterialThicknessMicron', 'InputMaterialWidth', 'TypeOfFilm', 'WaveCut', 'FreeMargin',
    'MPPFilmTurns', 'Resistivity', 'WrappingTurns', 'ReDie', 'CanSize', 'BarrierHeightTurns',
    'CoreLength', 'CoreOD', 'FilmSticker1_URL', 'FilmSticker2_URL', 'CurrentStage', 'Status',
    'CreatedDate', 'CreatedBy', 'QAVerdict', 'CompletedDate'
  ],
  'FilmLoadReadings': ['MasterBatchNo', 'SNo', 'Reading1', 'Reading2', 'Reading3', 'Reading4'],
  'Winding': ['MasterBatchNo', 'Date', 'Shift', 'MCNo', 'TotalQty', 'BinsQty', 'OperatorName', 'Remarks', 'ProdSupervisor', 'PQA'],
  'PaperMaskingSpray': [
    'MasterBatchNo', 'Date', 'Shift', 'MCNo', 'GunDistance', 'SprayThickness', 'Side1WireSpeed', 'Side2WireSpeed',
    'Voltage_G1', 'Voltage_G2', 'Voltage_G3', 'Voltage_G4', 'Voltage_G5', 'Voltage_G6', 'Voltage_G7', 'Voltage_G8',
    'Current_G1', 'Current_G2', 'Current_G3', 'Current_G4', 'Current_G5', 'Current_G6', 'Current_G7', 'Current_G8',
    'AirPressure_AP1', 'AirPressure_AP2', 'AirPressure_AP3', 'AirPressure_AP4', 'AirPressure_AP5', 'AirPressure_AP6', 'AirPressure_AP7', 'AirPressure_AP8',
    'TotalQty', 'GoodQty', 'RejectQty', 'TraysQty', 'OperatorName', 'Remarks', 'ProdSupervisor'
  ],
  'HeatStabilization': ['MasterBatchNo', 'Date', 'Shift', 'MCNo', 'ProcessTimeHrs', 'TimeIn', 'TimeOut', 'CoolingTimeHrs', 'TotalQty', 'GoodQty', 'RejectQty', 'TraysQty', 'OperatorName'],
  'ShortClearing': [
    'MasterBatchNo', 'Date', 'Shift', 'MCNo', 'ClearingVoltageDC', 'ClearingVoltageAC', 'ReactorBalancingMFD',
    'ClearingTimeSec', 'Tand1Khz', 'CapToleranceMin', 'CapToleranceMax', 'TotalQty', 'GoodQty', 'RejectQty',
    'DrumsQty', 'BinsQty', 'Weight', 'OperatorName', 'Remarks', 'RetestingStamp',
    'RetestClearingVoltageDC', 'RetestClearingVoltageAC', 'RetestReactorBalancingMFD', 'RetestOperatorName'
  ],
  'ShortClearing_Testing': ['MasterBatchNo', 'RoundType', 'Date', 'TotalQty', 'GoodQty', 'HVBurst', 'CapPlus', 'CapMinus', 'Tand', 'RejectionPct'],
  'Welding': [
    'MasterBatchNo', 'Date', 'Shift', 'MCNo', 'CopperStripWireSize', 'StrippingLength', 'AssemblyDeltaWireType',
    'WireGauge', 'Resistor', 'WireColor', 'MetalTopConnection', 'TotalQty', 'GoodQty', 'RejectQty', 'DrumsQty', 'BinsQty', 'OperatorName', 'Remarks'
  ],
  'PouringCuring': ['MasterBatchNo', 'Date', 'Shift', 'MCNo', 'ResinWeight', 'CapacitorWeight', 'TotalQty', 'GoodQty', 'RejectQty', 'DrumsQty', 'BinsQty', 'OperatorName', 'Remarks'],
  'PouringElectricalPacking': [
    'MasterBatchNo', 'Date', 'Shift', 'MCNo', 'KV', 'VdcForSec', 'IPA', 'BatchLotNo', 'CapTolerance', 'MFD',
    'Tand_1KHz_100Hz_50Hz', 'TotalQty', 'GoodQty', 'RejectQty', 'DrumsQty', 'BinsQty', 'OperatorName', 'Remarks'
  ],
  'BDVFinalTesting': [
    'MasterBatchNo', 'Date', 'Shift', 'MCNo', 'BDV', 'CapTolerance', 'MFD', 'Tand_1KHz_100Hz_50Hz', 'HVAC', 'VacForSec',
    'PrintingVerifiedBy', 'InnerBoxWeightKgs', 'MasterBoxWeightKgs', 'CapacitorsPerBox', 'TotalBoxes',
    'VisualInspectionSampleSize', 'ElectricalInspectionSampleSize', 'TotalQty', 'GoodQty', 'RejectQty', 'TraysQty', 'BinsQty', 'OperatorName', 'Remarks'
  ],
  'FinalQA_Results': ['MasterBatchNo', 'TestType', 'SampleID', 'Reading', 'FOAInspectorName', 'Notes', 'Date', 'Verdict'],
  'Stage_Skips': ['MasterBatchNo', 'Stage', 'Date', 'By', 'Reason'],
  'Code_Sequences': CODE_SEQUENCES_HEADERS,
  'AuditLog': ['Timestamp', 'User', 'Action', 'Module', 'RecordID', 'OldValue', 'NewValue'],
  'Stage_Access': ['Stage', 'Departments'],
  'Idempotency': ['ClientTxnId', 'Action', 'User', 'Timestamp', 'Result']
};

// Every tab that holds stage entries can have one voided.
['Winding', 'PaperMaskingSpray', 'HeatStabilization', 'ShortClearing', 'ShortClearing_Testing', 'Welding',
 'PouringCuring', 'PouringElectricalPacking', 'BDVFinalTesting', 'FinalQA_Results', 'Stage_Skips'].forEach(function (t) {
  ELE_TAB_SCHEMA[t] = ELE_TAB_SCHEMA[t].concat(VOID_COLUMNS);
});

// ============================================================
// UTILS — generic sheet helpers
// ============================================================

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

// A tab's header row, read once per execution and reused. Every append
// and lookup used to read it again, which made a Final QA submission
// about fifty sheet calls while every other device waited on the lock.
// Anything that adds a column clears it (ensureColumns_).
var _sheetMetaCache_ = {};
function sheetMeta_(sheet) {
  var key = sheet.getParent().getId() + '!' + sheet.getSheetId();
  if (_sheetMetaCache_[key]) return _sheetMetaCache_[key];
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var map = {};
  headers.forEach(function (h, i) { if (h) map[h] = i; });
  var meta = { map: map, headers: headers, lastCol: lastCol };
  _sheetMetaCache_[key] = meta;
  return meta;
}

function invalidateSheetMeta_(sheet) {
  delete _sheetMetaCache_[sheet.getParent().getId() + '!' + sheet.getSheetId()];
}

// Adds any of these headers the tab doesn't have yet, at the end, so a tab
// set up before a column existed gains it on first use. Never moves or
// renames a column.
function ensureColumns_(sheet, names) {
  var meta = sheetMeta_(sheet);
  var missing = names.filter(function (n) { return meta.map[n] === undefined; });
  if (missing.length === 0) return;
  sheet.getRange(1, meta.lastCol + 1, 1, missing.length).setValues([missing]);
  invalidateSheetMeta_(sheet);
}

function headerIndexMap_(sheet) {
  return sheetMeta_(sheet).map;
}

function readSheetAsObjects_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var meta = sheetMeta_(sheet);
  var headers = meta.headers;
  var values = sheet.getRange(2, 1, lastRow - 1, meta.lastCol).getValues();
  return values.map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) { if (h) obj[h] = row[i]; });
    return obj;
  }).filter(function (obj) {
    return Object.keys(obj).some(function (k) { return obj[k] !== '' && obj[k] !== null; });
  });
}

// Sheets reads a cell that starts with = + - or @ as a formula, so a remark
// that happens to start that way would become #ERROR!, or a formula running
// inside the spreadsheet. A leading apostrophe tells Sheets "this is text";
// Sheets drops it, so reading the cell back gives exactly what was typed.
//
// A reading that is simply a number — "-2.5" from a test grid — is left
// alone, so Sheets stores it as the number -2.5. Escaped, it would become
// text: it would look the same, but sums and charts would skip it.
function sheetSafe_(v) {
  if (typeof v !== 'string' || !/^[=+\-@]/.test(v)) return v;
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v.trim())) return v;
  return "'" + v;
}

// A form sends a date as "2026-09-24". new Date() reads that as midnight
// UTC, which Sheets shows in India as 05:30. Built from its parts, it is
// midnight in the script's own time zone.
function parseDay_(v) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
}

function rowFromObject_(meta, rowObj) {
  var row = new Array(meta.lastCol).fill('');
  Object.keys(rowObj).forEach(function (key) {
    if (meta.map[key] !== undefined) row[meta.map[key]] = sheetSafe_(rowObj[key]);
  });
  return row;
}

function appendRowByHeader_(sheet, rowObj) {
  sheet.appendRow(rowFromObject_(sheetMeta_(sheet), rowObj));
}

// Several rows in one write — a Final QA grid or a set of test rounds —
// rather than one call per row while the lock is held.
function appendRowsByHeader_(sheet, rowObjs) {
  if (!rowObjs.length) return;
  var meta = sheetMeta_(sheet);
  var rows = rowObjs.map(function (o) { return rowFromObject_(meta, o); });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, meta.lastCol).setValues(rows);
}

function isVoided_(r) {
  return r.Voided === true || String(r.Voided).toUpperCase() === 'TRUE';
}

// The newest rows of a stage tab, voided entries left out. Rows are
// appended in time order, so the newest are at the bottom.
function readEntries_(tabName, params, sortByDate) {
  var rows = readSheetAsObjects_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName))
    .filter(function (r) { return !isVoided_(r); });
  var limit = Math.min(Number(params && params.limit) || ENTRIES_DEFAULT_LIMIT, ENTRIES_MAX_LIMIT);
  if (rows.length > limit) rows = rows.slice(rows.length - limit);
  if (sortByDate) rows.sort(function (a, b) { return new Date(b.Date).getTime() - new Date(a.Date).getTime(); });
  return rows;
}

// Who recorded what, and when. Created on first use, so a sheet set up
// before the log existed gains it without a setup run.
function logAudit_(user, action, module, recordId, oldValue, newValue) {
  try {
    var sheet = getOrCreateSheet_(SpreadsheetApp.getActiveSpreadsheet(), 'AuditLog', ELE_TAB_SCHEMA['AuditLog']);
    appendRowByHeader_(sheet, {
      Timestamp: new Date(), User: user, Action: action, Module: module, RecordID: recordId,
      OldValue: oldValue === undefined ? '' : oldValue, NewValue: newValue === undefined ? '' : newValue
    });
  } catch (err) {
    // The log never blocks the work it records.
    Logger.log('Audit log write failed: ' + err.message);
  }
}

// What an entry said, for the log: everything the form sent except the
// session, cut short if a big grid made it long.
function auditSummary_(params) {
  var copy = {};
  Object.keys(params || {}).forEach(function (k) { if (k !== 'token' && k !== 'action') copy[k] = params[k]; });
  var text = JSON.stringify(copy);
  return text.length > 1500 ? text.slice(0, 1500) + '\u2026' : text;
}

function findRowIndexByValue_(sheet, header, value) {
  var map = headerIndexMap_(sheet);
  if (map[header] === undefined) return -1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var col = sheet.getRange(2, map[header] + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < col.length; i++) {
    if (String(col[i][0]) === String(value)) return i + 2;
  }
  return -1;
}

function getOrCreateSheet_(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name);
  if (sheet) return sheet;
  sheet = spreadsheet.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeader_(sheet, headers.length);
  return sheet;
}

function styleHeader_(sheet, numCols) {
  var range = sheet.getRange(1, 1, 1, numCols);
  range.setFontWeight('bold').setBackground('#0f172a').setFontColor('#f8fafc');
  sheet.setFrozenRows(1);
}

function isActiveValue_(val) {
  if (val === false) return false;
  if (typeof val === 'string' && val.toUpperCase() === 'FALSE') return false;
  return true;
}

// ============================================================
// AUTH — validated against Stock Management's Sessions sheet
// ============================================================

// openById is one of the slower calls in Apps Script, and a single request
// can reach Stock Management more than once (the session check, then FG
// data or the Users tab). Opened once per execution and reused.
var _stockSpreadsheet = null;
function getStockSpreadsheet_() {
  if (!_stockSpreadsheet) _stockSpreadsheet = SpreadsheetApp.openById(STOCK_SHEET_ID);
  return _stockSpreadsheet;
}

// Returns { Token, Username, Role, Department, CreatedAt, ExpiresAt } or
// null if the token is missing, unknown, or expired.
//
// Runs on every request, so it locates the one matching row with a
// TextFinder instead of reading the whole Sessions sheet. That keeps its
// cost flat however many sessions have accumulated — which matters if
// Stock Management's nightly cleanup trigger isn't installed and the sheet
// grows unchecked.
//
// Deliberately uncached. Stock Management caches sessions in its own
// script cache and evicts on sign-out, but this project's cache is a
// different one that a sign-out there can't reach — a cached token would
// stay valid here for as long as its TTL after the person signed out.
// Reading the sheet directly means a sign-out takes effect immediately.
function validateSharedSession_(token) {
  token = String(token || '').trim();
  if (!token) return null;
  var sheet = getStockSpreadsheet_().getSheetByName('Sessions');
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return null;

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var tokenCol = headers.indexOf('Token');
  if (tokenCol === -1) return null;

  var hit = sheet.getRange(2, tokenCol + 1, lastRow - 1, 1)
    .createTextFinder(token).matchCase(true).matchEntireCell(true).findNext();
  if (!hit) return null;

  var values = sheet.getRange(hit.getRow(), 1, 1, lastCol).getValues()[0];
  var session = {};
  headers.forEach(function (h, i) { if (h) session[h] = values[i]; });
  // A blank or unreadable ExpiresAt counts as expired. new Date('') is
  // NaN, and NaN < now is false, so such a row used to never expire.
  var expires = session.ExpiresAt ? new Date(session.ExpiresAt).getTime() : NaN;
  if (isNaN(expires) || expires < Date.now()) return null;
  return session;
}

function isMfgAdmin_(session) {
  return session.Role === 'Admin';
}

// Grants travel on the session row this app already reads to check the
// token, so no lookup is needed.
function can_(session, key) {
  if (isMfgAdmin_(session)) return true;
  return String(session.Perms || '').split(',').indexOf(key) > -1;
}

var _stageAccess = null;
function readStageAccess_() {
  if (_stageAccess) return _stageAccess;
  var map = {};
  var split = function (text) {
    return String(text || '').split(',').map(function (d) { return d.trim(); }).filter(Boolean);
  };
  STAGE_ACCESS_DEFAULT.forEach(function (r) { map[r[0]] = split(r[1]); });
  // A missing tab (renamed, or setup never run) leaves the defaults above
  // in force, rather than failing every request, sign-in included.
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Stage_Access');
  if (sheet) readSheetAsObjects_(sheet).forEach(function (r) {
    var stage = String(r.Stage || '').trim();
    if (stage && map[stage] !== undefined) map[stage] = split(r.Departments);
  });
  _stageAccess = map;
  return map;
}

function stageDepartments_(permission) {
  return readStageAccess_()[STAGE_PERMISSIONS[permission]] || [];
}

function hasPermission_(session, permission) {
  if (isMfgAdmin_(session) || can_(session, 'ele.stage.any')) return true;
  if (!can_(session, 'ele.stage.record')) return false;
  var mine = String(session.Department || '').trim().toLowerCase();
  return stageDepartments_(permission).some(function (d) { return d.toLowerCase() === mine; });
}

function requireStageAccess_(session, permission) {
  if (hasPermission_(session, permission)) return;
  if (!can_(session, 'ele.stage.record')) {
    throw new Error('You don\u2019t have access to record stages in ELE. Ask an Admin to grant it in Team & Access.');
  }
  var depts = stageDepartments_(permission);
  throw new Error(STAGE_PERMISSIONS[permission] + ' is recorded by ' + (depts.join(', ') || 'no department yet') +
                  '. Ask an Admin if you need to record it too.');
}

// ============================================================
// WRITE LOCK — one script lock per request for every write
//
// Each stage reads the batch's CurrentStage, checks it, appends its row,
// then advances the stage. Without a lock around all four steps, two
// devices submitting the same stage together both pass the check before
// either has advanced it, and both entries get written.
//
// The lock is taken once, at the request boundary (handleRequest_), and
// nextFYSerial_ reuses it rather than taking its own. Acquiring a second
// time inside the same execution would be pointless, and releasing it from
// the inner call would drop protection for the rest of the request.
// ============================================================

// Anything not listed here is treated as a write. A new write action is
// therefore locked by default; a new read that isn't named get* merely
// gives up some concurrency, which is the safe way round to be wrong.
function isReadOnlyAction_(action) {
  return action === 'ping' || action === 'whoami' || /^get[A-Z]/.test(action);
}

var _holdsWriteLock = false;

function withWriteLock_(fn) {
  if (_holdsWriteLock) return fn();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(WRITE_LOCK_WAIT_MS)) {
    throw new Error('Another entry is being saved right now — please try again in a moment.');
  }
  _holdsWriteLock = true;
  try {
    return fn();
  } finally {
    // Apps Script buffers sheet writes. Flushing before the release is what
    // makes the lock mean anything: otherwise the next request can take the
    // lock and still read the old CurrentStage — or the old serial counter,
    // and hand out a MasterBatchNo that already exists.
    try { SpreadsheetApp.flush(); }
    finally { _holdsWriteLock = false; lock.releaseLock(); }
  }
}

// ============================================================
// CODEGEN — financial-year-scoped serial numbers
//
// Each prefix (WIND, etc.) gets its own counter, keyed by "{prefix}-{FY}"
// in Code_Sequences, and resets every April 1 (Indian FY). Returns only
// the padded serial — each stage assembles its own full code string,
// since the formats genuinely differ (Winding's
// {Machine}_{MFD}_{Date}_{serial} vs. others).
// ============================================================

// "25-26" for any date between 1 Apr 2025 and 31 Mar 2026. Dates here are
// in the script's time zone, so the project must be set to Asia/Kolkata
// (Project Settings) for the year to roll over at Indian midnight on
// 1 April; ADMIN_setupSheet says if it isn't.
function getCurrentFY_() {
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth() + 1; // 1-12
  var fyStartYear = month >= 4 ? year : year - 1;
  var fyEndYear = fyStartYear + 1;
  return String(fyStartYear).slice(-2) + '-' + String(fyEndYear).slice(-2);
}

// Called from inside a locked write request, so withWriteLock_ runs it
// under the lock that request already holds. Still wrapped, so a direct
// call from the editor (or any future caller outside a request) is
// protected too.
function nextFYSerial_(prefix, pad) {
  pad = pad || 5;
  var fy = getCurrentFY_();
  var key = prefix + '-' + fy;
  return withWriteLock_(function () {
    var sheet = getOrCreateSheet_(SpreadsheetApp.getActiveSpreadsheet(), 'Code_Sequences', CODE_SEQUENCES_HEADERS);
    var rowIdx = findRowIndexByValue_(sheet, 'Key', key);
    var next;
    if (rowIdx === -1) {
      next = 1;
      appendRowByHeader_(sheet, { Key: key, Prefix: prefix, FY: fy, LastNumber: next });
    } else {
      var map = headerIndexMap_(sheet);
      var current = Number(sheet.getRange(rowIdx, map['LastNumber'] + 1).getValue()) || 0;
      next = current + 1;
      sheet.getRange(rowIdx, map['LastNumber'] + 1).setValue(next);
    }
    return ('0000000000' + next).slice(-pad);
  });
}

// ============================================================
// STAGE HELPERS — shared by every stage from Spray through BDV
//
// Every mid-chain stage follows the same shape: look the batch up by
// MasterBatchNo, confirm it's currently sitting at the stage right
// before this one (the physical card's fixed order), then move it
// forward once logged. These three functions are that shape, factored
// out so each stage below only states what's actually different: its
// own sheet name, its own fields, and its own prior/next stage names.
// ============================================================

// Looks up a BatchMaster row by MasterBatchNo. Throws if blank or not
// found. Returns everything a stage function needs to both read
// CurrentStage and write it back without a second lookup.
function getBatchRow_(masterBatchNo) {
  masterBatchNo = String(masterBatchNo || '').trim();
  if (!masterBatchNo) throw new Error('Master Batch No is required');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BatchMaster');
  var rowIdx = findRowIndexByValue_(sheet, 'MasterBatchNo', masterBatchNo);
  if (rowIdx === -1) throw new Error('Master Batch No not found: ' + masterBatchNo);
  var map = headerIndexMap_(sheet);
  return {
    masterBatchNo: masterBatchNo,
    sheet: sheet,
    rowIdx: rowIdx,
    map: map,
    currentStage: sheet.getRange(rowIdx, map['CurrentStage'] + 1).getValue(),
    status: map['Status'] !== undefined ? sheet.getRange(rowIdx, map['Status'] + 1).getValue() : ''
  };
}

// Enforces the card's stage order.
function requireStage_(batch, expectedStage, stageLabel) {
  if (batch.currentStage !== expectedStage) {
    throw new Error('Batch must be at ' + expectedStage + ' before ' + stageLabel + ' can log it (currently: ' + batch.currentStage + ')');
  }
}

// Moves the batch forward to the next stage on the card.
function advanceStage_(batch, newStage) {
  batch.sheet.getRange(batch.rowIdx, batch.map['CurrentStage'] + 1).setValue(newStage);
}

// Good + Reject can't come to more than Total: those three are what yield
// and rejection figures are worked out from. Left blank, a count isn't
// checked.
function checkQuantities_(params) {
  var n = function (v) { return v === undefined || v === null || String(v).trim() === '' ? null : Number(v); };
  var total = n(params.totalQty), good = n(params.goodQty), reject = n(params.rejectQty);
  [['Total', total], ['Good', good], ['Reject', reject]].forEach(function (pair) {
    if (pair[1] !== null && (isNaN(pair[1]) || pair[1] < 0)) throw new Error(pair[0] + ' qty must be a number, 0 or more.');
  });
  if (total !== null && (good || 0) + (reject || 0) > total) {
    throw new Error('Good (' + (good || 0) + ') + Reject (' + (reject || 0) + ') comes to more than Total (' + total + '). Check the counts.');
  }
}

// A stage reporting more pieces than the stage before it passed as good is
// usually a miscount, but rework can add pieces back, so it is saved and
// the person told rather than refused. prevTabs: [tab, label] pairs; the
// first with an entry for this batch is the one compared against (Pouring
// & Curing, then Welding when Pouring was marked not applicable).
function previousGoodWarning_(batch, params, prevTabs) {
  var total = Number(params.totalQty);
  if (params.totalQty === undefined || String(params.totalQty).trim() === '' || isNaN(total)) return '';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  for (var i = 0; i < prevTabs.length; i++) {
    var rows = readSheetAsObjects_(ss.getSheetByName(prevTabs[i][0])).filter(function (r) {
      return String(r.MasterBatchNo) === batch.masterBatchNo && !isVoided_(r);
    });
    if (!rows.length) continue;
    // Winding has no Good column: its shifts' totals are what it passed on.
    var field = prevTabs[i][0] === 'Winding' ? 'TotalQty' : 'GoodQty';
    var prev = 0, any = false;
    rows.forEach(function (r) {
      if (r[field] !== '' && r[field] !== null && !isNaN(Number(r[field]))) { prev += Number(r[field]); any = true; }
    });
    if (!any || total <= prev) return '';
    return 'Total ' + total + ' is more than the ' + prev + (field === 'TotalQty' ? ' wound' : ' good') + ' at ' + prevTabs[i][1] +
           '. Fine if that\u2019s rework; otherwise check the count.';
  }
  return '';
}

function stageResult_(batch, warning) {
  var out = { masterBatchNo: batch.masterBatchNo };
  if (warning) out.warning = warning;
  return out;
}

// ============================================================
// PHASE 1: WINDING
//
// createWindingBatch_ is where MasterBatchNo actually gets assembled —
// {Machine}_{MFD}_{DD/MM/YYYY}_{5-digit FY serial} — and where the
// BatchMaster header row gets created. addWindingShift_ handles the
// physical card's reality that a batch can continue across shifts (the
// card prints three blank rows, A/B/C) — same MasterBatchNo, no new
// code, just another row in Winding.
//
// The FY-scoped serial is one shared sequence for all Winding batches
// regardless of machine — "unique for the financial year" was the
// instruction, not "unique per machine."
// ============================================================

function assembleMasterBatchNo_(machine, mfd, dateObj) {
  var tz = Session.getScriptTimeZone();
  var dateStr = Utilities.formatDate(dateObj, tz, 'dd/MM/yyyy');
  var serial = nextFYSerial_('WIND', 5);
  return machine + '_' + mfd + '_' + dateStr + '_' + serial;
}

function appendWindingShift_(masterBatchNo, params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Winding');
  appendRowByHeader_(sheet, {
    MasterBatchNo: masterBatchNo,
    Date: params.date ? parseDay_(params.date) : new Date(),
    Shift: params.shift || '',
    MCNo: params.mcNo || '',
    TotalQty: params.totalQty || '',
    BinsQty: params.binsQty || '',
    OperatorName: params.operatorName || '',
    Remarks: params.remarks || '',
    ProdSupervisor: params.prodSupervisor || '',
    PQA: params.pqa || ''
  });
}

function createWindingBatch_(session, params) {
  requireStageAccess_(session, 'enterWinding');

  var fgCode = String(params.fgCode || '').trim();
  var mcNo = String(params.mcNo || '').trim();
  var mfd = String(params.mfd || '').trim();
  if (!fgCode) throw new Error('FG code is required');
  if (!mcNo) throw new Error('Machine is required');
  if (!mfd) throw new Error('MFD is required');
  checkQuantities_(params);

  var fg = readSheetAsObjects_(getStockSpreadsheet_().getSheetByName('FG_Master')).filter(function (r) { return r.FG_Code === fgCode; })[0];
  if (!fg) throw new Error('Unknown FG code: ' + fgCode);
  if (!isActiveValue_(fg.Active)) throw new Error('FG code is inactive: ' + fgCode);

  var now = new Date();
  var masterBatchNo = assembleMasterBatchNo_(mcNo, mfd, now);

  appendRowByHeader_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BatchMaster'), {
    MasterBatchNo: masterBatchNo,
    WindingProgramNo: params.windingProgramNo || '',
    CycleTime: params.cycleTime || '',
    DrawingNo: params.drawingNo || '',
    FGCode: fgCode,
    ElementBatchNo: masterBatchNo, // same value by definition, not separately entered
    DatePlanning: now,
    MFD: mfd,
    Voltage: params.voltage || '',
    CustomerName: params.customerName || '',
    BatchQty: params.batchQty || '',
    FilmBatchNo: '', // composed once Metallization + Slitting codes exist (Manufacturing Tracker rebuild)
    InputMaterialThicknessMicron: params.inputThickness || '',
    InputMaterialWidth: params.inputWidth || '',
    TypeOfFilm: params.typeOfFilm || '',
    WaveCut: !!params.waveCut,
    FreeMargin: params.freeMargin || '',
    MPPFilmTurns: params.mppFilmTurns || '',
    Resistivity: params.resistivity || '',
    WrappingTurns: params.wrappingTurns || '',
    ReDie: params.reDie || '',
    CanSize: params.canSize || '',
    BarrierHeightTurns: params.barrierHeightTurns || '',
    CoreLength: params.coreLength || '',
    CoreOD: params.coreOD || '',
    FilmSticker1_URL: '', // Phase 6
    FilmSticker2_URL: '',
    CurrentStage: 'Winding',
    Status: 'In Process',
    CreatedDate: now,
    CreatedBy: session.Username
  });

  if (Array.isArray(params.filmLoadReadings)) {
    var flSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('FilmLoadReadings');
    appendRowsByHeader_(flSheet, params.filmLoadReadings.filter(function (r) { return r && r.sNo; }).map(function (r) {
      return {
        MasterBatchNo: masterBatchNo, SNo: r.sNo,
        Reading1: r.reading1 || '', Reading2: r.reading2 || '', Reading3: r.reading3 || '', Reading4: r.reading4 || ''
      };
    }));
  }

  appendWindingShift_(masterBatchNo, params);
  return { masterBatchNo: masterBatchNo };
}

function addWindingShift_(session, params) {
  requireStageAccess_(session, 'enterWinding');
  checkQuantities_(params);
  var batch = getBatchRow_(params.masterBatchNo);
  appendWindingShift_(batch.masterBatchNo, params);
  return { masterBatchNo: batch.masterBatchNo };
}

function getWindingEntries_(params) {
  return readEntries_('Winding', params, true);
}

function getBatchMasterList_() {
  var rows = readSheetAsObjects_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BatchMaster'));
  rows.sort(function (a, b) { return new Date(b.CreatedDate).getTime() - new Date(a.CreatedDate).getTime(); });
  return rows;
}

function getFGCatalog_() {
  var sheet = getStockSpreadsheet_().getSheetByName('FG_Master');
  return readSheetAsObjects_(sheet)
    .filter(function (r) { return isActiveValue_(r.Active); })
    .map(function (r) { return { code: r.FG_Code, name: r.FG_Name }; });
}

// ============================================================
// PHASE 2: SPRAY (1 of 2) — requires batch at Winding, moves to Spray
// ============================================================

function enterSpray_(session, params) {
  requireStageAccess_(session, 'enterSpray');
  var batch = getBatchRow_(params.masterBatchNo);
  requireStage_(batch, 'Winding', 'Spray');
  checkQuantities_(params);
  var warning = previousGoodWarning_(batch, params, [['Winding', 'Winding']]);

  var rowObj = {
    MasterBatchNo: batch.masterBatchNo,
    Date: params.date ? parseDay_(params.date) : new Date(),
    Shift: params.shift || '',
    MCNo: params.mcNo || '',
    GunDistance: params.gunDistance || '',
    SprayThickness: params.sprayThickness || '',
    Side1WireSpeed: params.side1WireSpeed || '',
    Side2WireSpeed: params.side2WireSpeed || '',
    TotalQty: params.totalQty || '',
    GoodQty: params.goodQty || '',
    RejectQty: params.rejectQty || '',
    TraysQty: params.traysQty || '',
    OperatorName: params.operatorName || '',
    Remarks: params.remarks || '',
    ProdSupervisor: params.prodSupervisor || ''
  };
  // 24 reading columns: G1-G8 voltage, G1-G8 current, AP1-AP8 air pressure
  for (var i = 1; i <= 8; i++) {
    rowObj['Voltage_G' + i] = params['voltageG' + i] || '';
    rowObj['Current_G' + i] = params['currentG' + i] || '';
    rowObj['AirPressure_AP' + i] = params['airPressureAP' + i] || '';
  }
  appendRowByHeader_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PaperMaskingSpray'), rowObj);

  advanceStage_(batch, 'Spray');
  return stageResult_(batch, warning);
}

function getSprayEntries_(params) {
  return readEntries_('PaperMaskingSpray', params, true);
}

// ============================================================
// PHASE 2: HEAT STABILIZATION (2 of 2) — requires batch at Spray
// ============================================================

function enterHeatStab_(session, params) {
  requireStageAccess_(session, 'enterHeatStab');
  var batch = getBatchRow_(params.masterBatchNo);
  requireStage_(batch, 'Spray', 'Heat Stabilization');
  checkQuantities_(params);
  var warning = previousGoodWarning_(batch, params, [['PaperMaskingSpray', 'Spray']]);

  appendRowByHeader_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('HeatStabilization'), {
    MasterBatchNo: batch.masterBatchNo,
    Date: params.date ? parseDay_(params.date) : new Date(),
    Shift: params.shift || '',
    MCNo: params.mcNo || '',
    ProcessTimeHrs: params.processTimeHrs || '',
    TimeIn: params.timeIn || '',
    TimeOut: params.timeOut || '',
    CoolingTimeHrs: params.coolingTimeHrs || '',
    TotalQty: params.totalQty || '',
    GoodQty: params.goodQty || '',
    RejectQty: params.rejectQty || '',
    TraysQty: params.traysQty || '',
    OperatorName: params.operatorName || ''
  });

  advanceStage_(batch, 'Heat Stabilization');
  return stageResult_(batch, warning);
}

function getHeatStabEntries_(params) {
  return readEntries_('HeatStabilization', params, true);
}

// ============================================================
// PHASE 3: SHORT CLEARING — requires batch at Heat Stabilization
//
// Testing rounds (Round-1, and Round-2/Recovered/TotalQty "if required")
// are part of the same card section, so they're submitted together in
// one call rather than as separate actions — pass whichever rounds
// actually have data in testingRounds.
// ============================================================

function enterShortClearing_(session, params) {
  requireStageAccess_(session, 'enterShortClearing');
  var batch = getBatchRow_(params.masterBatchNo);
  requireStage_(batch, 'Heat Stabilization', 'Short Clearing');
  checkQuantities_(params);
  var warning = previousGoodWarning_(batch, params, [['HeatStabilization', 'Heat Stabilization']]);

  appendRowByHeader_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('ShortClearing'), {
    MasterBatchNo: batch.masterBatchNo,
    Date: params.date ? parseDay_(params.date) : new Date(),
    Shift: params.shift || '',
    MCNo: params.mcNo || '',
    ClearingVoltageDC: params.clearingVoltageDC || '',
    ClearingVoltageAC: params.clearingVoltageAC || '',
    ReactorBalancingMFD: params.reactorBalancingMFD || '',
    ClearingTimeSec: params.clearingTimeSec || '',
    Tand1Khz: params.tand1Khz || '',
    CapToleranceMin: params.capToleranceMin || '',
    CapToleranceMax: params.capToleranceMax || '',
    TotalQty: params.totalQty || '',
    GoodQty: params.goodQty || '',
    RejectQty: params.rejectQty || '',
    DrumsQty: params.drumsQty || '',
    BinsQty: params.binsQty || '',
    Weight: params.weight || '',
    OperatorName: params.operatorName || '',
    Remarks: params.remarks || '',
    RetestingStamp: !!params.retestingStamp,
    // Retest-specific readings — a separate DC/AC/Reactor/Operator set the
    // card calls for only inside "Retesting (If Required)", distinct from
    // the initial readings above. Blank when the batch wasn't retested.
    RetestClearingVoltageDC: params.retestClearingVoltageDC || '',
    RetestClearingVoltageAC: params.retestClearingVoltageAC || '',
    RetestReactorBalancingMFD: params.retestReactorBalancingMFD || '',
    RetestOperatorName: params.retestOperatorName || ''
  });

  if (Array.isArray(params.testingRounds)) {
    var testingSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('ShortClearing_Testing');
    appendRowsByHeader_(testingSheet, params.testingRounds.filter(function (r) { return r && r.roundType; }).map(function (r) {
      return {
        MasterBatchNo: batch.masterBatchNo,
        RoundType: r.roundType,
        Date: r.date ? parseDay_(r.date) : new Date(),
        TotalQty: r.totalQty || '',
        GoodQty: r.goodQty || '',
        HVBurst: r.hvBurst || '',
        CapPlus: r.capPlus || '',
        CapMinus: r.capMinus || '',
        Tand: r.tand || '',
        RejectionPct: r.rejectionPct || ''
      };
    }));
  }

  advanceStage_(batch, 'Short Clearing');
  return stageResult_(batch, warning);
}

function getShortClearingEntries_(params) {
  return readEntries_('ShortClearing', params, true);
}

function getShortClearingTestResults_(params) {
  return readEntries_('ShortClearing_Testing', params, true);
}

// ============================================================
// PHASE 4: WELDING (1 of 3) — requires batch at Short Clearing
// ============================================================

function enterWelding_(session, params) {
  requireStageAccess_(session, 'enterWelding');
  var batch = getBatchRow_(params.masterBatchNo);
  requireStage_(batch, 'Short Clearing', 'Welding');
  checkQuantities_(params);
  var warning = previousGoodWarning_(batch, params, [['ShortClearing', 'Short Clearing']]);

  appendRowByHeader_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Welding'), {
    MasterBatchNo: batch.masterBatchNo,
    Date: params.date ? parseDay_(params.date) : new Date(),
    Shift: params.shift || '',
    MCNo: params.mcNo || '',
    CopperStripWireSize: params.copperStripWireSize || '',
    StrippingLength: params.strippingLength || '',
    AssemblyDeltaWireType: params.assemblyDeltaWireType || '',
    WireGauge: params.wireGauge || '',
    Resistor: params.resistor || '',
    WireColor: params.wireColor || '',
    MetalTopConnection: params.metalTopConnection || '',
    TotalQty: params.totalQty || '',
    GoodQty: params.goodQty || '',
    RejectQty: params.rejectQty || '',
    DrumsQty: params.drumsQty || '',
    BinsQty: params.binsQty || '',
    OperatorName: params.operatorName || '',
    Remarks: params.remarks || ''
  });

  advanceStage_(batch, 'Welding');
  return stageResult_(batch, warning);
}

function getWeldingEntries_(params) {
  return readEntries_('Welding', params, true);
}

// ============================================================
// PHASE 4: POURING & CURING (2 of 3) — Kvar/Aircon/Oil capacitors only,
// per the card's own section title. Requires batch at Welding.
// ============================================================

function enterPouringCuring_(session, params) {
  requireStageAccess_(session, 'enterPouringCuring');
  var batch = getBatchRow_(params.masterBatchNo);
  requireStage_(batch, 'Welding', 'Pouring & Curing');
  checkQuantities_(params);
  var warning = previousGoodWarning_(batch, params, [['Welding', 'Welding']]);

  appendRowByHeader_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PouringCuring'), {
    MasterBatchNo: batch.masterBatchNo,
    Date: params.date ? parseDay_(params.date) : new Date(),
    Shift: params.shift || '',
    MCNo: params.mcNo || '',
    ResinWeight: params.resinWeight || '',
    CapacitorWeight: params.capacitorWeight || '',
    TotalQty: params.totalQty || '',
    GoodQty: params.goodQty || '',
    RejectQty: params.rejectQty || '',
    DrumsQty: params.drumsQty || '',
    BinsQty: params.binsQty || '',
    OperatorName: params.operatorName || '',
    Remarks: params.remarks || ''
  });

  advanceStage_(batch, 'Pouring & Curing');
  return stageResult_(batch, warning);
}

function getPouringCuringEntries_(params) {
  return readEntries_('PouringCuring', params, true);
}

// ============================================================
// PHASE 4: ELECTRICAL TESTING & PACKING (3 of 3)
// "Pouring, Electrical Testing, Laser Printing & Packing (Auto/Manual
// Assembly)" on the card. Requires batch at Pouring & Curing.
// ============================================================

function enterElectricalPacking_(session, params) {
  requireStageAccess_(session, 'enterElectricalPacking');
  var batch = getBatchRow_(params.masterBatchNo);
  requireStage_(batch, 'Pouring & Curing', 'Electrical Testing & Packing');
  checkQuantities_(params);
  var warning = previousGoodWarning_(batch, params, [['PouringCuring', 'Pouring & Curing'], ['Welding', 'Welding']]);

  appendRowByHeader_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PouringElectricalPacking'), {
    MasterBatchNo: batch.masterBatchNo,
    Date: params.date ? parseDay_(params.date) : new Date(),
    Shift: params.shift || '',
    MCNo: params.mcNo || '',
    KV: params.kv || '',
    VdcForSec: params.vdcForSec || '',
    IPA: params.ipa || '',
    BatchLotNo: params.batchLotNo || '',
    CapTolerance: params.capTolerance || '',
    MFD: params.mfd || '',
    Tand_1KHz_100Hz_50Hz: params.tand || '',
    TotalQty: params.totalQty || '',
    GoodQty: params.goodQty || '',
    RejectQty: params.rejectQty || '',
    DrumsQty: params.drumsQty || '',
    BinsQty: params.binsQty || '',
    OperatorName: params.operatorName || '',
    Remarks: params.remarks || ''
  });

  advanceStage_(batch, 'Electrical Testing & Packing');
  return stageResult_(batch, warning);
}

function getElectricalPackingEntries_(params) {
  return readEntries_('PouringElectricalPacking', params, true);
}

// ============================================================
// PHASE 5: BDV & FINAL TESTING (1 of 2)
// "BDV (F.C.), Final Testing, Printing/Labeling, Visual Inspection &
// Packing" on the card. Requires batch at Electrical Testing & Packing —
// the last stage before Final QA.
// ============================================================

function enterBDV_(session, params) {
  requireStageAccess_(session, 'enterBDV');
  var batch = getBatchRow_(params.masterBatchNo);
  requireStage_(batch, 'Electrical Testing & Packing', 'BDV & Final Testing');
  checkQuantities_(params);
  var warning = previousGoodWarning_(batch, params, [['PouringElectricalPacking', 'Electrical Testing & Packing']]);

  appendRowByHeader_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BDVFinalTesting'), {
    MasterBatchNo: batch.masterBatchNo,
    Date: params.date ? parseDay_(params.date) : new Date(),
    Shift: params.shift || '',
    MCNo: params.mcNo || '',
    BDV: params.bdv || '',
    CapTolerance: params.capTolerance || '',
    MFD: params.mfd || '',
    Tand_1KHz_100Hz_50Hz: params.tand || '',
    HVAC: params.hvac || '',
    VacForSec: params.vacForSec || '',
    PrintingVerifiedBy: params.printingVerifiedBy || '',
    InnerBoxWeightKgs: params.innerBoxWeightKgs || '',
    MasterBoxWeightKgs: params.masterBoxWeightKgs || '',
    CapacitorsPerBox: params.capacitorsPerBox || '',
    TotalBoxes: params.totalBoxes || '',
    VisualInspectionSampleSize: params.visualInspectionSampleSize || '',
    ElectricalInspectionSampleSize: params.electricalInspectionSampleSize || '',
    TotalQty: params.totalQty || '',
    GoodQty: params.goodQty || '',
    RejectQty: params.rejectQty || '',
    TraysQty: params.traysQty || '',
    BinsQty: params.binsQty || '',
    OperatorName: params.operatorName || '',
    Remarks: params.remarks || ''
  });

  advanceStage_(batch, 'BDV & Final Testing');
  return stageResult_(batch, warning);
}

function getBDVEntries_(params) {
  return readEntries_('BDVFinalTesting', params, true);
}

// ============================================================
// PHASE 5: FINAL QA (2 of 2) — last stage in the 9-stage chain.
//
// Different shape from every other stage — a test x sample grid (up to
// 4 test types x up to 4 samples), not a single settings+shift row.
// Requires batch at BDV & Final Testing. The inspector's verdict sets the
// batch's Status: Pass marks it Complete, Reject marks it Rejected, and
// Hold leaves it at Final QA, On Hold, to be tested again. Every round's
// readings are kept, dated and with that round's verdict.
// ============================================================

var QA_VERDICTS = { Pass: 'Complete', Hold: 'On Hold', Reject: 'Rejected' };

function submitFinalQA_(session, params) {
  requireStageAccess_(session, 'enterFinalQA');
  if (!String(params.masterBatchNo || '').trim()) throw new Error('Master Batch No is required');
  var verdict = String(params.verdict || '').trim();
  if (!QA_VERDICTS[verdict]) {
    throw new Error('Pick the QA verdict: Pass, Hold or Reject. If the form has no verdict box, reload the app.');
  }
  var rows = (Array.isArray(params.results) ? params.results : []).filter(function (r) { return r && r.testType && r.sampleId; });
  if (rows.length === 0) throw new Error('At least one test result is required');
  var batch = getBatchRow_(params.masterBatchNo);
  // A batch put on hold is tested again from where it stands.
  var retest = batch.currentStage === 'Final QA' && batch.status === 'On Hold';
  if (!retest) requireStage_(batch, 'BDV & Final Testing', 'Final QA');

  var now = new Date();
  var resultsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('FinalQA_Results');
  ensureColumns_(resultsSheet, ['Date', 'Verdict']);
  appendRowsByHeader_(resultsSheet, rows.map(function (r) {
    return {
      MasterBatchNo: batch.masterBatchNo,
      TestType: r.testType,
      SampleID: r.sampleId,
      Reading: r.reading || '',
      FOAInspectorName: params.foaInspectorName || '',
      Notes: params.notes || '',
      Date: now,
      Verdict: verdict
    };
  }));

  var status = QA_VERDICTS[verdict];
  advanceStage_(batch, 'Final QA');
  ensureColumns_(batch.sheet, ['QAVerdict', 'CompletedDate']);
  var map = headerIndexMap_(batch.sheet);
  batch.sheet.getRange(batch.rowIdx, map['Status'] + 1).setValue(status);
  batch.sheet.getRange(batch.rowIdx, map['QAVerdict'] + 1).setValue(verdict);
  batch.sheet.getRange(batch.rowIdx, map['CompletedDate'] + 1).setValue(verdict === 'Hold' ? '' : now);
  return { masterBatchNo: batch.masterBatchNo, status: status, verdict: verdict };
}

function getFinalQAResults_(params) {
  return readEntries_('FinalQA_Results', params);
}

// ============================================================
// NOT APPLICABLE — a stage some batches don't go through
//
// Pouring & Curing is for Kvar, Aircon and Oil capacitors (the card's own
// heading), but Electrical Testing & Packing requires a batch to have
// passed it. A batch it doesn't apply to is marked "Not applicable" here:
// the skip is logged with who marked it and why, and the batch moves on
// as if the stage were done. The order of the card is unchanged, and a
// batch that is poured is entered exactly as before.
// ============================================================

// Each stage that can be marked not applicable, with the stage a batch
// must be at first and the permission that records it.
var OPTIONAL_STAGES = {
  'Pouring & Curing': { after: 'Welding', permission: 'enterPouringCuring' }
};

function skipStage_(session, params) {
  var stage = String(params.stage || '').trim();
  var rule = OPTIONAL_STAGES[stage];
  if (!rule) throw new Error((stage || 'That stage') + ' can\u2019t be marked not applicable.');
  requireStageAccess_(session, rule.permission);
  var batch = getBatchRow_(params.masterBatchNo);
  requireStage_(batch, rule.after, stage);

  var sheet = getOrCreateSheet_(SpreadsheetApp.getActiveSpreadsheet(), 'Stage_Skips', ELE_TAB_SCHEMA['Stage_Skips']);
  appendRowByHeader_(sheet, {
    MasterBatchNo: batch.masterBatchNo, Stage: stage, Date: new Date(), By: session.Username,
    Reason: String(params.reason || '').trim()
  });
  advanceStage_(batch, stage);
  return { masterBatchNo: batch.masterBatchNo, stage: stage, skipped: true };
}

function getStageSkips_(params) {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Stage_Skips')) return [];
  return readEntries_('Stage_Skips', params, true);
}

// ============================================================
// VOID — an Admin takes back a batch's latest stage entry
//
// A wrong entry used to be fixable only by editing the sheet, and a batch
// couldn't be stepped back. Voiding marks the batch's current stage entry
// (its rows stay, marked Voided with who, when and why) and moves
// CurrentStage back one step, so that stage can be entered again. Only the
// latest stage can be voided, so the card's order always holds. Voiding
// Final QA puts the batch back In Process.
// ============================================================

// The card in order. CurrentStage names the last stage a batch finished.
var STAGE_CHAIN = [
  { stage: 'Winding', tabs: ['Winding'] },
  { stage: 'Spray', tabs: ['PaperMaskingSpray'] },
  { stage: 'Heat Stabilization', tabs: ['HeatStabilization'] },
  { stage: 'Short Clearing', tabs: ['ShortClearing', 'ShortClearing_Testing'] },
  { stage: 'Welding', tabs: ['Welding'] },
  { stage: 'Pouring & Curing', tabs: ['PouringCuring'] },
  { stage: 'Electrical Testing & Packing', tabs: ['PouringElectricalPacking'] },
  { stage: 'BDV & Final Testing', tabs: ['BDVFinalTesting'] },
  { stage: 'Final QA', tabs: ['FinalQA_Results'] }
];

function voidLastStage_(session, params) {
  if (!isMfgAdmin_(session)) throw new Error('Only an Admin can void an entry.');
  var reason = String(params.reason || '').trim();
  if (!reason) throw new Error('Say why the entry is being voided.');
  var batch = getBatchRow_(params.masterBatchNo);
  // The screen it was voided from must still be showing the batch as it is.
  if (params.stage && String(params.stage) !== String(batch.currentStage)) {
    throw new Error(batch.masterBatchNo + ' is at ' + batch.currentStage + ' now, not ' + params.stage + '. Reload and try again.');
  }
  var at = -1;
  STAGE_CHAIN.forEach(function (c, i) { if (c.stage === batch.currentStage) at = i; });
  if (at === -1) throw new Error(batch.masterBatchNo + '\u2019s stage (' + batch.currentStage + ') isn\u2019t one of the card\u2019s stages.');
  if (at === 0) throw new Error('A batch at Winding has no later entry to void. A wrong winding shift is corrected in the sheet.');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var now = new Date();
  var voided = 0;
  var mark = function (sheet, keep) {
    if (!sheet || sheet.getLastRow() < 2) return;
    ensureColumns_(sheet, VOID_COLUMNS);
    var meta = sheetMeta_(sheet);
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, meta.lastCol).getValues();
    values.forEach(function (row, i) {
      var r = {};
      meta.headers.forEach(function (h, c) { if (h) r[h] = row[c]; });
      if (String(r.MasterBatchNo) !== batch.masterBatchNo || isVoided_(r) || !keep(r)) return;
      var set = { Voided: true, VoidedBy: session.Username, VoidedAt: now, VoidReason: reason };
      Object.keys(set).forEach(function (k) { sheet.getRange(i + 2, meta.map[k] + 1).setValue(sheetSafe_(set[k])); });
      voided++;
    });
  };
  STAGE_CHAIN[at].tabs.forEach(function (t) { mark(ss.getSheetByName(t), function () { return true; }); });
  mark(ss.getSheetByName('Stage_Skips'), function (r) { return r.Stage === batch.currentStage; });

  var back = STAGE_CHAIN[at - 1].stage;
  advanceStage_(batch, back);
  if (batch.currentStage === 'Final QA') {
    var map = headerIndexMap_(batch.sheet);
    batch.sheet.getRange(batch.rowIdx, map['Status'] + 1).setValue('In Process');
    if (map['QAVerdict'] !== undefined) batch.sheet.getRange(batch.rowIdx, map['QAVerdict'] + 1).setValue('');
    if (map['CompletedDate'] !== undefined) batch.sheet.getRange(batch.rowIdx, map['CompletedDate'] + 1).setValue('');
  }
  logAudit_(session.Username, 'VOID_STAGE', 'ELE', batch.masterBatchNo, batch.currentStage,
            'Stepped back to ' + back + ' \u00b7 ' + voided + ' row' + (voided === 1 ? '' : 's') + ' voided \u00b7 ' + reason);
  return { masterBatchNo: batch.masterBatchNo, voidedStage: batch.currentStage, currentStage: back, rowsVoided: voided };
}

// Everything recorded against one batch, voided entries left out, for its
// report. The lists the app loads hold only recent rows; this reads the
// batch's own rows whatever their age.
function getBatchRecord_(params) {
  var no = String(params.masterBatchNo || '').trim();
  if (!no) throw new Error('Master Batch No is required');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pick = function (tab) {
    var sheet = ss.getSheetByName(tab);
    if (!sheet) return [];
    return readSheetAsObjects_(sheet).filter(function (r) { return String(r.MasterBatchNo) === no && !isVoided_(r); });
  };
  return {
    masterBatchNo: no,
    winding: pick('Winding'), spray: pick('PaperMaskingSpray'), heatStab: pick('HeatStabilization'),
    shortClearing: pick('ShortClearing'), scTesting: pick('ShortClearing_Testing'), welding: pick('Welding'),
    pouringCuring: pick('PouringCuring'), electricalPacking: pick('PouringElectricalPacking'), bdv: pick('BDVFinalTesting'),
    finalQa: pick('FinalQA_Results'), skips: pick('Stage_Skips')
  };
}

// ============================================================
// IDEMPOTENCY — a resent write gets its first answer back
//
// The app gives each entry a clientTxnId and sends the same one again if
// the reply was lost. Looked up and recorded inside the write lock, so a
// resend that arrives while the original is still running waits for it,
// then finds it.
// ============================================================

function findIdempotentResult_(clientTxnId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(IDEMPOTENCY_TAB);
  if (!sheet) return null;
  var meta = sheetMeta_(sheet);
  if (meta.map['ClientTxnId'] === undefined) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var startRow = Math.max(2, lastRow - IDEMPOTENCY_SCAN_ROWS + 1);
  var ids = sheet.getRange(startRow, meta.map['ClientTxnId'] + 1, lastRow - startRow + 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) !== clientTxnId) continue;
    var values = sheet.getRange(startRow + i, 1, 1, meta.lastCol).getValues()[0];
    var row = {};
    meta.headers.forEach(function (h, c) { if (h) row[h] = values[c]; });
    var result = null;
    try { result = JSON.parse(row.Result || 'null'); } catch (err) { result = null; }
    return { action: row.Action, user: row.User, result: result };
  }
  return null;
}

function recordIdempotentResult_(clientTxnId, action, username, result) {
  var sheet = getOrCreateSheet_(SpreadsheetApp.getActiveSpreadsheet(), IDEMPOTENCY_TAB, ELE_TAB_SCHEMA[IDEMPOTENCY_TAB]);
  appendRowByHeader_(sheet, {
    ClientTxnId: clientTxnId, Action: action, User: username || '', Timestamp: new Date(),
    Result: JSON.stringify(result === undefined ? null : result)
  });
}

// IDs are random per entry, so one that comes back for another action or
// another person is a client bug, not a resend; replaying it would report
// work that wasn't done.
function replayOf_(clientTxnId, action, session) {
  var prior = findIdempotentResult_(clientTxnId);
  if (!prior) return null;
  if (prior.action && prior.action !== action) {
    throw new Error('This entry\u2019s ID was already used for a different action (' + prior.action + '). Reload the app and try again.');
  }
  if (prior.user && prior.user !== session.Username) {
    throw new Error('This entry\u2019s ID belongs to someone else\u2019s entry. Reload the app and try again.');
  }
  var replay = prior.result;
  if (replay && typeof replay === 'object' && !Array.isArray(replay)) replay.duplicate = true;
  return { result: replay };
}

// ============================================================
// API ROUTING — doGet/doPost entry points
//
// No login of its own — every action except PUBLIC_ACTIONS requires a
// `token` param, validated against Stock Management's Sessions sheet.
// ============================================================

function doPost(e) { return handleRequest_(e); }

function doGet(e) {
  return jsonResponse_({ success: false, error: 'This API accepts POST requests only.' });
}

function handleRequest_(e) {
  var params = {};
  try {
    if (e.postData && e.postData.contents) {
      params = JSON.parse(e.postData.contents);
    } else if (e.parameter) {
      params = e.parameter;
    }

    var action = params.action;
    if (!action) throw new Error('Missing action');

    var session = null;
    if (PUBLIC_ACTIONS.indexOf(action) === -1) {
      session = validateSharedSession_(params.token);
      if (!session) throw new Error('Invalid or expired session — please log in again');
    }

    // Reads run concurrently; everything else is serialized — see WRITE LOCK.
    var data;
    if (isReadOnlyAction_(action)) {
      data = routeAction_(action, session, params);
    } else {
      data = withWriteLock_(function () {
        var clientTxnId = String(params.clientTxnId || '').trim();
        if (clientTxnId) {
          var replay = replayOf_(clientTxnId, action, session);
          if (replay) return replay.result;
        }
        var result = routeAction_(action, session, params);
        if (clientTxnId) recordIdempotentResult_(clientTxnId, action, session.Username, result);
        var batchNo = params.masterBatchNo || (result && (result.masterBatchNo || result.MasterBatchNo)) || '';
        logAudit_(session.Username, action, 'ELE', batchNo, '', auditSummary_(params));
        return result;
      });
    }
    return jsonResponse_({ success: true, data: data });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function routeAction_(action, session, params) {
  switch (action) {
    case 'ping':
      return { ok: true, time: new Date() };
    case 'whoami':
      return getWhoAmI_(session);
    case 'getDropdowns':
      return getAllDropdowns_();

    // --- Phase 1: Winding + code generation ---
    case 'createWindingBatch':
      return createWindingBatch_(session, params);
    case 'addWindingShift':
      return addWindingShift_(session, params);
    case 'getWindingEntries':
      return getWindingEntries_(params);
    case 'getBatchMasterList':
      return getBatchMasterList_();
    case 'getFGCatalog':
      return getFGCatalog_();

    // --- Phase 2: Spray + Heat Stabilization ---
    case 'enterSpray':
      return enterSpray_(session, params);
    case 'getSprayEntries':
      return getSprayEntries_(params);
    case 'enterHeatStab':
      return enterHeatStab_(session, params);
    case 'getHeatStabEntries':
      return getHeatStabEntries_(params);

    // --- Phase 3: Short Clearing ---
    case 'enterShortClearing':
      return enterShortClearing_(session, params);
    case 'getShortClearingEntries':
      return getShortClearingEntries_(params);
    case 'getShortClearingTestResults':
      return getShortClearingTestResults_(params);

    // --- Phase 4: Welding + Pouring & Curing + Electrical Testing & Packing ---
    case 'enterWelding':
      return enterWelding_(session, params);
    case 'getWeldingEntries':
      return getWeldingEntries_(params);
    case 'enterPouringCuring':
      return enterPouringCuring_(session, params);
    case 'getPouringCuringEntries':
      return getPouringCuringEntries_(params);
    case 'enterElectricalPacking':
      return enterElectricalPacking_(session, params);
    case 'getElectricalPackingEntries':
      return getElectricalPackingEntries_(params);

    // --- Phase 5: BDV & Final Testing + Final QA (last two stages) ---
    case 'enterBDV':
      return enterBDV_(session, params);
    case 'getBDVEntries':
      return getBDVEntries_(params);
    case 'submitFinalQA':
      return submitFinalQA_(session, params);
    case 'getFinalQAResults':
      return getFinalQAResults_(params);

    // --- Not applicable, corrections, one batch's whole record ---
    case 'skipStage':
      return skipStage_(session, params);
    case 'getStageSkips':
      return getStageSkips_(params);
    case 'voidLastStage':
      return voidLastStage_(session, params);
    case 'getBatchRecord':
      return getBatchRecord_(params);

    default:
      throw new Error('Unknown action: ' + action);
  }
}

function getWhoAmI_(session) {
  var usersSheet = getStockSpreadsheet_().getSheetByName('Users');
  var user = readSheetAsObjects_(usersSheet).filter(function (u) { return u.Username === session.Username; })[0];
  return {
    username: session.Username,
    name: user ? user.Name : session.Username,
    role: session.Role,
    department: session.Department,
    isAdmin: isMfgAdmin_(session),
    permissions: {
      enterWinding: hasPermission_(session, 'enterWinding'),
      enterSpray: hasPermission_(session, 'enterSpray'),
      enterHeatStab: hasPermission_(session, 'enterHeatStab'),
      enterShortClearing: hasPermission_(session, 'enterShortClearing'),
      enterWelding: hasPermission_(session, 'enterWelding'),
      enterPouringCuring: hasPermission_(session, 'enterPouringCuring'),
      enterElectricalPacking: hasPermission_(session, 'enterElectricalPacking'),
      enterBDV: hasPermission_(session, 'enterBDV'),
      enterFinalQA: hasPermission_(session, 'enterFinalQA')
    }
  };
}

// One call, every list — every stage's form needs a handful of these, so
// fetching them all at login avoids a round-trip per dropdown per page.
//
// The Dropdowns tab holds one list per column: the header names the list,
// and blank cells below a shorter list are ignored. Read in a single
// getValues and split in memory — reading column by column cost several
// sheet calls per list, across thirty-odd lists, on the login path.
function getAllDropdowns_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Dropdowns');
  if (!sheet || sheet.getLastRow() < 1) return {};
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var rows = values.slice(1);
  var result = {};
  headers.forEach(function (name, c) {
    if (!name) return;
    result[name] = rows
      .map(function (r) { return r[c]; })
      .filter(function (v) { return v !== '' && v !== null; });
  });
  return result;
}

// ============================================================
// SETUP — run once from the editor on a fresh ELE spreadsheet to create
// every tab in ELE_TAB_SCHEMA. Safe to re-run: existing tabs are left
// untouched and only missing ones are created.
// ============================================================

function ADMIN_setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var created = [];
  var existing = [];
  var columnsAdded = [];
  Object.keys(ELE_TAB_SCHEMA).forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (sheet) {
      existing.push(name);
      // A tab made before a column existed gains it, at the end. Nothing
      // already there moves. Dropdowns is left alone: its columns are
      // lists people add as they need them.
      if (name !== 'Dropdowns' && sheet.getLastColumn() > 0) {
        var before = sheetMeta_(sheet).lastCol;
        ensureColumns_(sheet, ELE_TAB_SCHEMA[name]);
        if (sheetMeta_(sheet).lastCol > before) columnsAdded.push(name);
      }
      return;
    }
    getOrCreateSheet_(ss, name, ELE_TAB_SCHEMA[name]);
    created.push(name);
  });
  // Which departments record each stage starts as the standard set; after
  // that it is edited in the sheet, and never overwritten here.
  var access = ss.getSheetByName('Stage_Access');
  if (access && access.getLastRow() < 2) {
    STAGE_ACCESS_DEFAULT.forEach(function (r) { appendRowByHeader_(access, { Stage: r[0], Departments: r[1] }); });
  }

  var sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && ss.getSheets().length > 1 && sheet1.getLastRow() === 0) ss.deleteSheet(sheet1);

  var tz = Session.getScriptTimeZone();
  var tzNote = tz === 'Asia/Kolkata' ? '' :
    'The script\u2019s time zone is ' + tz + ', not Asia/Kolkata, so batch serials roll over to the new financial year at the wrong hour. ' +
    'Change it under Project Settings \u2192 Time zone.';

  Logger.log('Created: ' + (created.join(', ') || '(none — all tabs already existed)'));
  Logger.log('Already existed: ' + (existing.join(', ') || '(none)'));
  Logger.log('New columns added to: ' + (columnsAdded.join(', ') || '(none)'));
  if (tzNote) Logger.log(tzNote);
  return { created: created, existing: existing, columnsAdded: columnsAdded, timeZoneNote: tzNote };
}