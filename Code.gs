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
 * submission for the same batch.
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
    'CreatedDate', 'CreatedBy'
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
  'FinalQA_Results': ['MasterBatchNo', 'TestType', 'SampleID', 'Reading', 'FOAInspectorName', 'Notes'],
  'Code_Sequences': CODE_SEQUENCES_HEADERS,
  'AuditLog': ['Timestamp', 'User', 'Action', 'Module', 'RecordID', 'OldValue', 'NewValue'],
  'Stage_Access': ['Stage', 'Departments']
};

// ============================================================
// UTILS — generic sheet helpers
// ============================================================

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function headerIndexMap_(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  headers.forEach(function (h, i) { if (h) map[h] = i; });
  return map;
}

function readSheetAsObjects_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
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

function appendRowByHeader_(sheet, rowObj) {
  var map = headerIndexMap_(sheet);
  var row = new Array(sheet.getLastColumn()).fill('');
  Object.keys(rowObj).forEach(function (key) {
    if (map[key] !== undefined) row[map[key]] = sheetSafe_(rowObj[key]);
  });
  sheet.appendRow(row);
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
  if (new Date(session.ExpiresAt).getTime() < Date.now()) return null;
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
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Stage_Access');
  readSheetAsObjects_(sheet).forEach(function (r) {
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

// "25-26" for any date between 1 Apr 2025 and 31 Mar 2026.
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
    currentStage: sheet.getRange(rowIdx, map['CurrentStage'] + 1).getValue()
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
    params.filmLoadReadings.forEach(function (r) {
      if (!r.sNo) return;
      appendRowByHeader_(flSheet, {
        MasterBatchNo: masterBatchNo, SNo: r.sNo,
        Reading1: r.reading1 || '', Reading2: r.reading2 || '', Reading3: r.reading3 || '', Reading4: r.reading4 || ''
      });
    });
  }

  appendWindingShift_(masterBatchNo, params);
  return { masterBatchNo: masterBatchNo };
}

function addWindingShift_(session, params) {
  requireStageAccess_(session, 'enterWinding');
  var batch = getBatchRow_(params.masterBatchNo);
  appendWindingShift_(batch.masterBatchNo, params);
  return { masterBatchNo: batch.masterBatchNo };
}

function getWindingEntries_() {
  var rows = readSheetAsObjects_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Winding'));
  rows.sort(function (a, b) { return new Date(b.Date).getTime() - new Date(a.Date).getTime(); });
  return rows;
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
  return { masterBatchNo: batch.masterBatchNo };
}

function getSprayEntries_() {
  var rows = readSheetAsObjects_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PaperMaskingSpray'));
  rows.sort(function (a, b) { return new Date(b.Date).getTime() - new Date(a.Date).getTime(); });
  return rows;
}

// ============================================================
// PHASE 2: HEAT STABILIZATION (2 of 2) — requires batch at Spray
// ============================================================

function enterHeatStab_(session, params) {
  requireStageAccess_(session, 'enterHeatStab');
  var batch = getBatchRow_(params.masterBatchNo);
  requireStage_(batch, 'Spray', 'Heat Stabilization');

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
  return { masterBatchNo: batch.masterBatchNo };
}

function getHeatStabEntries_() {
  var rows = readSheetAsObjects_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('HeatStabilization'));
  rows.sort(function (a, b) { return new Date(b.Date).getTime() - new Date(a.Date).getTime(); });
  return rows;
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
    params.testingRounds.forEach(function (r) {
      if (!r.roundType) return;
      appendRowByHeader_(testingSheet, {
        MasterBatchNo: batch.masterBatchNo,
        RoundType: r.roundType,
        Date: r.date ? new Date(r.date) : new Date(),
        TotalQty: r.totalQty || '',
        GoodQty: r.goodQty || '',
        HVBurst: r.hvBurst || '',
        CapPlus: r.capPlus || '',
        CapMinus: r.capMinus || '',
        Tand: r.tand || '',
        RejectionPct: r.rejectionPct || ''
      });
    });
  }

  advanceStage_(batch, 'Short Clearing');
  return { masterBatchNo: batch.masterBatchNo };
}

function getShortClearingEntries_() {
  var rows = readSheetAsObjects_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('ShortClearing'));
  rows.sort(function (a, b) { return new Date(b.Date).getTime() - new Date(a.Date).getTime(); });
  return rows;
}

function getShortClearingTestResults_() {
  var rows = readSheetAsObjects_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('ShortClearing_Testing'));
  rows.sort(function (a, b) { return new Date(b.Date).getTime() - new Date(a.Date).getTime(); });
  return rows;
}

// ============================================================
// PHASE 4: WELDING (1 of 3) — requires batch at Short Clearing
// ============================================================

function enterWelding_(session, params) {
  requireStageAccess_(session, 'enterWelding');
  var batch = getBatchRow_(params.masterBatchNo);
  requireStage_(batch, 'Short Clearing', 'Welding');

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
  return { masterBatchNo: batch.masterBatchNo };
}

function getWeldingEntries_() {
  var rows = readSheetAsObjects_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Welding'));
  rows.sort(function (a, b) { return new Date(b.Date).getTime() - new Date(a.Date).getTime(); });
  return rows;
}

// ============================================================
// PHASE 4: POURING & CURING (2 of 3) — Kvar/Aircon/Oil capacitors only,
// per the card's own section title. Requires batch at Welding.
// ============================================================

function enterPouringCuring_(session, params) {
  requireStageAccess_(session, 'enterPouringCuring');
  var batch = getBatchRow_(params.masterBatchNo);
  requireStage_(batch, 'Welding', 'Pouring & Curing');

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
  return { masterBatchNo: batch.masterBatchNo };
}

function getPouringCuringEntries_() {
  var rows = readSheetAsObjects_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PouringCuring'));
  rows.sort(function (a, b) { return new Date(b.Date).getTime() - new Date(a.Date).getTime(); });
  return rows;
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
  return { masterBatchNo: batch.masterBatchNo };
}

function getElectricalPackingEntries_() {
  var rows = readSheetAsObjects_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PouringElectricalPacking'));
  rows.sort(function (a, b) { return new Date(b.Date).getTime() - new Date(a.Date).getTime(); });
  return rows;
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
  return { masterBatchNo: batch.masterBatchNo };
}

function getBDVEntries_() {
  var rows = readSheetAsObjects_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BDVFinalTesting'));
  rows.sort(function (a, b) { return new Date(b.Date).getTime() - new Date(a.Date).getTime(); });
  return rows;
}

// ============================================================
// PHASE 5: FINAL QA (2 of 2) — last stage in the 9-stage chain.
//
// Different shape from every other stage — a test x sample grid (up to
// 4 test types x up to 4 samples), not a single settings+shift row.
// Requires batch at BDV & Final Testing. Since nothing comes after this,
// a submission here also flips the batch's Status from 'In Process' to
// 'Complete' — this is the end of the technical record for the batch.
// ============================================================

function submitFinalQA_(session, params) {
  requireStageAccess_(session, 'enterFinalQA');
  if (!String(params.masterBatchNo || '').trim()) throw new Error('Master Batch No is required');
  if (!Array.isArray(params.results) || params.results.length === 0) {
    throw new Error('At least one test result is required');
  }
  var batch = getBatchRow_(params.masterBatchNo);
  requireStage_(batch, 'BDV & Final Testing', 'Final QA');

  var resultsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('FinalQA_Results');
  params.results.forEach(function (r) {
    if (!r.testType || !r.sampleId) return;
    appendRowByHeader_(resultsSheet, {
      MasterBatchNo: batch.masterBatchNo,
      TestType: r.testType,
      SampleID: r.sampleId,
      Reading: r.reading || '',
      FOAInspectorName: params.foaInspectorName || '',
      Notes: params.notes || ''
    });
  });

  advanceStage_(batch, 'Final QA');
  batch.sheet.getRange(batch.rowIdx, batch.map['Status'] + 1).setValue('Complete');
  return { masterBatchNo: batch.masterBatchNo, status: 'Complete' };
}

function getFinalQAResults_() {
  return readSheetAsObjects_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('FinalQA_Results'));
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
        var result = routeAction_(action, session, params);
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
      return getWindingEntries_();
    case 'getBatchMasterList':
      return getBatchMasterList_();
    case 'getFGCatalog':
      return getFGCatalog_();

    // --- Phase 2: Spray + Heat Stabilization ---
    case 'enterSpray':
      return enterSpray_(session, params);
    case 'getSprayEntries':
      return getSprayEntries_();
    case 'enterHeatStab':
      return enterHeatStab_(session, params);
    case 'getHeatStabEntries':
      return getHeatStabEntries_();

    // --- Phase 3: Short Clearing ---
    case 'enterShortClearing':
      return enterShortClearing_(session, params);
    case 'getShortClearingEntries':
      return getShortClearingEntries_();
    case 'getShortClearingTestResults':
      return getShortClearingTestResults_();

    // --- Phase 4: Welding + Pouring & Curing + Electrical Testing & Packing ---
    case 'enterWelding':
      return enterWelding_(session, params);
    case 'getWeldingEntries':
      return getWeldingEntries_();
    case 'enterPouringCuring':
      return enterPouringCuring_(session, params);
    case 'getPouringCuringEntries':
      return getPouringCuringEntries_();
    case 'enterElectricalPacking':
      return enterElectricalPacking_(session, params);
    case 'getElectricalPackingEntries':
      return getElectricalPackingEntries_();

    // --- Phase 5: BDV & Final Testing + Final QA (last two stages) ---
    case 'enterBDV':
      return enterBDV_(session, params);
    case 'getBDVEntries':
      return getBDVEntries_();
    case 'submitFinalQA':
      return submitFinalQA_(session, params);
    case 'getFinalQAResults':
      return getFinalQAResults_();

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
  Object.keys(ELE_TAB_SCHEMA).forEach(function (name) {
    if (ss.getSheetByName(name)) { existing.push(name); return; }
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

  Logger.log('Created: ' + (created.join(', ') || '(none — all tabs already existed)'));
  Logger.log('Already existed: ' + (existing.join(', ') || '(none)'));
  return { created: created, existing: existing };
}