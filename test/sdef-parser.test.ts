/**
 * Tests for the .sdef parser and CRUDE classifier.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

import {
  classifySdefCommand,
  parseSdefFile,
  parseSdefXml,
  sdefToOperations,
} from "../src/sdef-parser.js";

// --- XML parsing ---

test("parseSdefXml: parses minimal sdef with one suite and one command", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<dictionary title="Test App">
  <suite name="Standard Suite" code="core" description="Common commands">
    <command name="get" code="coregetd" description="Get data from an object.">
      <direct-parameter type="specifier" description="the object to get"/>
      <result type="any" description="the data"/>
    </command>
  </suite>
</dictionary>`;

  const result = parseSdefXml(xml, "test");
  assert.equal(result.application, "Test App");
  assert.equal(result.suites.length, 1);
  assert.equal(result.suites[0].name, "Standard Suite");
  assert.equal(result.suites[0].commands.length, 1);
  assert.equal(result.suites[0].commands[0].name, "get");
  assert.equal(result.suites[0].commands[0].directParameter?.type, "specifier");
  assert.equal(result.suites[0].commands[0].result?.type, "any");
});

test("parseSdefXml: parses classes with properties and elements", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<dictionary title="Mail">
  <suite name="Mail Suite" code="emal" description="Mail specific">
    <class name="account" code="mact" description="An email account" plural="accounts">
      <property name="name" code="pnam" type="text" description="The name of the account" access="r"/>
      <property name="enabled" code="isEn" type="boolean" description="Is the account enabled?" access="rw"/>
      <element type="mailbox" access="r"/>
    </class>
  </suite>
</dictionary>`;

  const result = parseSdefXml(xml);
  const cls = result.suites[0].classes[0];
  assert.equal(cls.name, "account");
  assert.equal(cls.plural, "accounts");
  assert.equal(cls.properties.length, 2);
  assert.equal(cls.properties[0].name, "name");
  assert.equal(cls.properties[0].access, "r");
  assert.equal(cls.properties[1].name, "enabled");
  assert.equal(cls.properties[1].access, "rw");
  assert.equal(cls.elements.length, 1);
  assert.equal(cls.elements[0].type, "mailbox");
});

test("parseSdefXml: parses enumerations", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<dictionary title="Test">
  <suite name="Test Suite" code="test" description="Test">
    <enumeration name="save options" code="savo">
      <enumerator name="yes" code="yes " description="Save the file."/>
      <enumerator name="no" code="no  " description="Do not save the file."/>
      <enumerator name="ask" code="ask " description="Ask the user."/>
    </enumeration>
  </suite>
</dictionary>`;

  const result = parseSdefXml(xml);
  const enumeration = result.suites[0].enumerations[0];
  assert.equal(enumeration.name, "save options");
  assert.equal(enumeration.enumerators.length, 3);
  assert.equal(enumeration.enumerators[0].name, "yes");
});

test("parseSdefXml: parses command parameters", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<dictionary title="Test">
  <suite name="Standard Suite" code="core" description="Standard">
    <command name="move" code="coremove" description="Move an object to a new location.">
      <direct-parameter type="specifier" description="the object to move"/>
      <parameter name="to" code="insh" type="specifier" description="the new location" optional="no"/>
    </command>
  </suite>
</dictionary>`;

  const result = parseSdefXml(xml);
  const cmd = result.suites[0].commands[0];
  assert.equal(cmd.name, "move");
  assert.equal(cmd.parameters.length, 1);
  assert.equal(cmd.parameters[0].name, "to");
  assert.equal(cmd.parameters[0].optional, false);
});

test("parseSdefXml: handles self-closing tags", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<dictionary title="Test">
  <suite name="Test" code="test" description="Test">
    <class name="item" code="cobj" description="A basic item" plural="items">
      <property name="id" code="ID  " type="integer" description="The unique ID" access="r"/>
    </class>
  </suite>
</dictionary>`;

  const result = parseSdefXml(xml);
  assert.equal(result.suites[0].classes[0].properties[0].name, "id");
});

test("parseSdefXml: handles XML entities in attributes", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<dictionary title="Test &amp; App">
  <suite name="Test" code="test" description="Commands for the &quot;Test&quot; suite">
  </suite>
</dictionary>`;

  const result = parseSdefXml(xml);
  assert.equal(result.application, "Test & App");
  assert.equal(result.suites[0].description, 'Commands for the "Test" suite');
});

// --- CRUDE classification ---

test("classifySdefCommand: classifies 'get' as READ", () => {
  const result = classifySdefCommand({
    name: "get",
    code: "getd",
    description: "Get data from an object.",
    parameters: [],
  });
  assert.equal(result.endpoint, "READ");
  assert.equal(result.confidence, "high");
});

test("classifySdefCommand: classifies 'set' as UPDATE", () => {
  const result = classifySdefCommand({
    name: "set",
    code: "setd",
    description: "Set an object's data.",
    parameters: [],
  });
  assert.equal(result.endpoint, "UPDATE");
  assert.equal(result.confidence, "high");
});

test("classifySdefCommand: classifies 'make' as CREATE", () => {
  const result = classifySdefCommand({
    name: "make",
    code: "crel",
    description: "Create a new object.",
    parameters: [],
  });
  assert.equal(result.endpoint, "CREATE");
  assert.equal(result.confidence, "high");
});

test("classifySdefCommand: classifies 'delete' as DELETE", () => {
  const result = classifySdefCommand({
    name: "delete",
    code: "delo",
    description: "Delete an object.",
    parameters: [],
  });
  assert.equal(result.endpoint, "DELETE");
  assert.equal(result.confidence, "high");
});

test("classifySdefCommand: classifies 'move' as EXECUTE", () => {
  const result = classifySdefCommand({
    name: "move",
    code: "move",
    description: "Move an object to a new location.",
    parameters: [],
  });
  assert.equal(result.endpoint, "EXECUTE");
  assert.equal(result.confidence, "medium");
});

test("classifySdefCommand: classifies unknown command as EXECUTE with low confidence", () => {
  const result = classifySdefCommand({
    name: "bounce",
    code: "bnce",
    description: "Bounce a message back to the sender.",
    parameters: [],
  });
  assert.equal(result.endpoint, "EXECUTE");
  assert.equal(result.confidence, "low");
  assert.ok(result.reviewReasons.length > 0);
});

test("classifySdefCommand: uses description hints for ambiguous commands", () => {
  const result = classifySdefCommand({
    name: "check for new mail",
    code: "chml",
    description: "Retrieve new messages from mail servers.",
    parameters: [],
  });
  assert.equal(result.endpoint, "READ");
  assert.equal(result.confidence, "medium");
});

// --- sdefToOperations ---

test("sdefToOperations: generates read operations from read-only properties", () => {
  const sdef = parseSdefXml(`<?xml version="1.0" encoding="UTF-8"?>
<dictionary title="Test">
  <suite name="Test" code="test" description="Test">
    <class name="message" code="mssg" description="An email message" plural="messages">
      <property name="subject" code="subj" type="text" description="The subject" access="r"/>
    </class>
  </suite>
</dictionary>`);

  const { operations } = sdefToOperations(sdef);
  const readOps = operations.filter((op) => op.endpoint === "READ");
  const getSubject = readOps.find((op) => op.operation_name === "get_message_subject");
  assert.ok(getSubject, "Expected get_message_subject operation");
  assert.equal(getSubject?.params.length, 1);
  assert.match(getSubject?.maps_to ?? "", /native-applescript:get_property:message\.subject/);
});

test("sdefToOperations: generates read and write operations from rw properties", () => {
  const sdef = parseSdefXml(`<?xml version="1.0" encoding="UTF-8"?>
<dictionary title="Test">
  <suite name="Test" code="test" description="Test">
    <class name="message" code="mssg" description="An email message" plural="messages">
      <property name="read status" code="isrd" type="boolean" description="Has the message been read?" access="rw"/>
    </class>
  </suite>
</dictionary>`);

  const { operations } = sdefToOperations(sdef);
  const getOp = operations.find((op) => op.operation_name === "get_message_read_status");
  const setOp = operations.find((op) => op.operation_name === "set_message_read_status");
  assert.ok(getOp, "Expected get_message_read_status");
  assert.ok(setOp, "Expected set_message_read_status");
  assert.equal(getOp?.endpoint, "READ");
  assert.equal(setOp?.endpoint, "UPDATE");
});

test("sdefToOperations: generates element listing operations", () => {
  const sdef = parseSdefXml(`<?xml version="1.0" encoding="UTF-8"?>
<dictionary title="Test">
  <suite name="Test" code="test" description="Test">
    <class name="account" code="mact" description="An account" plural="accounts">
      <element type="mailbox" access="r"/>
    </class>
  </suite>
</dictionary>`);

  const { operations } = sdefToOperations(sdef);
  const listOp = operations.find((op) => op.operation_name === "list_account_mailboxes");
  assert.ok(listOp, "Expected list_account_mailboxes operation");
  assert.equal(listOp?.endpoint, "READ");
});

test("sdefToOperations: generates command operations", () => {
  const sdef = parseSdefXml(`<?xml version="1.0" encoding="UTF-8"?>
<dictionary title="Test">
  <suite name="Standard Suite" code="core" description="Standard">
    <command name="delete" code="delo" description="Delete an object.">
      <direct-parameter type="specifier" description="the object to delete"/>
    </command>
  </suite>
</dictionary>`);

  const { operations } = sdefToOperations(sdef);
  const deleteOp = operations.find((op) => op.operation_name === "delete");
  assert.ok(deleteOp, "Expected delete operation");
  assert.equal(deleteOp?.endpoint, "DELETE");
  assert.equal(deleteOp?.danger_level, "destructive");
  assert.match(deleteOp?.maps_to ?? "", /native-applescript:command:delete/);
});

test("sdefToOperations: respects suite filter", () => {
  const sdef = parseSdefXml(`<?xml version="1.0" encoding="UTF-8"?>
<dictionary title="Test">
  <suite name="Suite A" code="suta" description="Suite A">
    <command name="alpha" code="alfa" description="Alpha command."/>
  </suite>
  <suite name="Suite B" code="sutb" description="Suite B">
    <command name="beta" code="beta" description="Beta command."/>
  </suite>
</dictionary>`);

  const { operations } = sdefToOperations(sdef, { suiteFilter: ["Suite A"] });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].operation_name, "alpha");
});

test("sdefToOperations: can exclude properties and elements", () => {
  const sdef = parseSdefXml(`<?xml version="1.0" encoding="UTF-8"?>
<dictionary title="Test">
  <suite name="Test" code="test" description="Test">
    <command name="get" code="getd" description="Get data."/>
    <class name="item" code="cobj" description="An item" plural="items">
      <property name="name" code="pnam" type="text" description="Name" access="r"/>
      <element type="subitem" access="r"/>
    </class>
  </suite>
</dictionary>`);

  const { operations } = sdefToOperations(sdef, {
    includeProperties: false,
    includeElements: false,
  });
  // Should only have the command, not properties or elements
  assert.equal(operations.length, 1);
  assert.equal(operations[0].operation_name, "get");
});

// --- Real Mail.sdef integration test ---

const MAIL_SDEF_PATH = "/System/Applications/Mail.app/Contents/Resources/Mail.sdef";

test("parseSdefFile: parses real Mail.sdef", async (t) => {
  try {
    await access(MAIL_SDEF_PATH);
  } catch {
    t.skip("Mail.sdef not found - skipping integration test.");
    return;
  }

  const sdef = await parseSdefFile(MAIL_SDEF_PATH);
  assert.ok(sdef.suites.length > 0, "Expected at least one suite");

  // Mail.app typically has a "Mail" suite and "Standard Suite"
  const suiteNames = sdef.suites.map((s) => s.name);
  assert.ok(suiteNames.some((n) => n.includes("Mail") || n.includes("Standard")),
    `Expected a Mail or Standard suite, got: ${suiteNames.join(", ")}`);

  const { operations, warnings } = sdefToOperations(sdef);
  assert.ok(operations.length > 0, "Expected at least one operation from Mail.sdef");

  // Should have some READ operations (property access, 'get' command)
  const readOps = operations.filter((op) => op.endpoint === "READ");
  assert.ok(readOps.length > 0, "Expected READ operations from Mail.sdef");

  console.log(`  Mail.sdef: ${sdef.suites.length} suites, ${operations.length} operations, ${warnings.length} warnings`);
});
