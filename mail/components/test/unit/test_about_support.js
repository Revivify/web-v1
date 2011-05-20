/* ***** BEGIN LICENSE BLOCK *****
 *   Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is mozilla.org code.
 *
 * The Initial Developer of the Original Code is
 * the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Siddharth Agarwal <sid.bugzilla@gmail.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/*
 * Test the about:support module.
 */

let gAccountList = [{
  type: "pop3",
  port: 1234,
  user: "pop3user",
  password: "pop3password",
  socketType: Ci.nsMsgSocketType.plain,
  authMethod: Ci.nsMsgAuthMethod.old,
  smtpServers: [],
}, {
  type: "imap",
  port: 2345,
  user: "imapuser",
  password: "imappassword",
  socketType: Ci.nsMsgSocketType.trySTARTTLS,
  authMethod: Ci.nsMsgAuthMethod.passwordCleartext,
  smtpServers: [{
    port: 3456,
    user: "imapout",
    password: "imapoutpassword",
    isDefault: true,
    socketType: Ci.nsMsgSocketType.alwaysSTARTTLS,
    authMethod: Ci.nsMsgAuthMethod.passwordEncrypted,
  }],
}, {
  type: "nntp",
  port: 4567,
  user: null,
  password: null,
  socketType: Ci.nsMsgSocketType.SSL,
  authMethod: Ci.nsMsgAuthMethod.GSSAPI,
  smtpServers: [{
    port: 5678,
    user: "newsout1",
    password: "newsoutpassword1",
    isDefault: true,
    socketType: Ci.nsMsgSocketType.SSL,
    authMethod: Ci.nsMsgAuthMethod.NTLM,
  }, {
    port: 6789,
    user: "newsout2",
    password: "newsoutpassword2",
    isDefault: false,
    socketType: Ci.nsMsgSocketType.SSL,
    authMethod: Ci.nsMsgAuthMethod.External,
  }],
}];

/// A map of account keys to servers. Populated by setup_accounts.
let gAccountMap = {};
/// A map of SMTP server names to SMTP servers. Populated by setup_accounts.
let gSMTPMap = {};

/**
 * A list of sensitive data: it shouldn't be present in the account
 * details. Populated by setup_accounts.
 */
let gSensitiveData = [];

/**
 * Set up accounts based on the given data.
 */
function setup_accounts() {
  // First make sure the local folders account is set up.
  loadLocalMailAccount();

  // Now run through the details and set up accounts accordingly.
  for (let [, details] in Iterator(gAccountList)) {
    let server = create_incoming_server(details.type, details.port,
                                        details.user, details.password);
    server.socketType = details.socketType;
    server.authMethod = details.authMethod;
    gSensitiveData.push(details.password);
    for (let [, smtpDetails] in Iterator(details.smtpServers)) {
      let outgoing = create_outgoing_server(smtpDetails.port, smtpDetails.user,
                                            smtpDetails.password);
      outgoing.socketType = smtpDetails.socketType;
      outgoing.authMethod = smtpDetails.authMethod;
      associate_servers(server, outgoing, smtpDetails.isDefault);
      gSensitiveData.push(smtpDetails.password);

      // Add the SMTP server to our server name -> server map
      gSMTPMap["localhost:" + smtpDetails.port] = smtpDetails;
    }

    // Add the server to our account -> server map
    let account = MailServices.accounts.FindAccountForServer(server);
    gAccountMap[account.key] = details;
  }
}

/**
 * Verify that the given account's details match our details for the key.
 */
function verify_account_details(aDetails) {
  let expectedDetails = gAccountMap[aDetails.key];
  // All our servers are at localhost
  let expectedHostDetails = "(" + expectedDetails.type + ") localhost:" +
    expectedDetails.port;
  do_check_eq(aDetails.hostDetails, expectedHostDetails);
  do_check_eq(aDetails.socketType, expectedDetails.socketType);
  do_check_eq(aDetails.authMethod, expectedDetails.authMethod);

  let smtpToSee = [("localhost:" + smtpDetails.port)
                   for ([, smtpDetails] in Iterator(expectedDetails.smtpServers))];

  for (let [, smtpDetails] in Iterator(aDetails.smtpServers)) {
    // Check that we're expecting to see this server
    let toSeeIndex = smtpToSee.indexOf(smtpDetails.name);
    do_check_neq(toSeeIndex, -1);
    smtpToSee.splice(toSeeIndex, 1);

    let expectedSMTPDetails = gSMTPMap[smtpDetails.name];
    do_check_eq(smtpDetails.socketType, expectedSMTPDetails.socketType);
    do_check_eq(smtpDetails.authMethod, expectedSMTPDetails.authMethod);
    do_check_eq(smtpDetails.isDefault, expectedSMTPDetails.isDefault);
  }

  // Check that we saw all the SMTP servers we wanted to see
  do_check_eq(smtpToSee.length, 0);
}

/**
 * Tests the getFileSystemType function. This is more a check to make sure the
 * function returns something meaningful and doesn't throw an exception, since
 * we don't have any information about what sort of file system we're running
 * on.
 */
function test_get_file_system_type() {
  let fsType = AboutSupport.getFileSystemType(do_get_cwd());
  if ("nsILocalFileMac" in Ci)
    // Mac should return null
    do_check_eq(fsType, null);
  else
    // Windows and Linux should return a string
    do_check_true(["local", "network", "unknown"].indexOf(fsType) != -1);
}

/**
 * Test the getAccountDetails function.
 */
function test_get_account_details() {
  let accountDetails = AboutSupport.getAccountDetails();
  let accountDetailsText = uneval(accountDetails);
  // The list of accounts we are looking for
  let accountsToSee = [key for (key in Iterator(gAccountMap, true))];

  // Our first check is to see that no sensitive data has crept in
  for (let [, data] in Iterator(gSensitiveData))
    do_check_eq(accountDetailsText.indexOf(data), -1);

  for (let [, details] in Iterator(accountDetails)) {
    // We're going to make one exception: for the local folders server. We don't
    // care too much about its details.
    if (details.key == gLocalMsgAccount.key)
      continue;

    // Check that we're expecting to see this server
    let toSeeIndex = accountsToSee.indexOf(details.key);
    do_check_neq(toSeeIndex, -1);
    accountsToSee.splice(toSeeIndex, 1);

    verify_account_details(details);
  }
  // Check that we got all the accounts we wanted to see
  do_check_eq(accountsToSee.length, 0);  
}

var tests = [
  test_get_file_system_type,
  test_get_account_details,
];

function run_test() {
  if ("@mozilla.org/gnome-gconf-service;1" in Cc) {
    // The GNOME GConf service needs to be initialized, otherwise we get
    // assertions about g_type_init not being called.
    Cc["@mozilla.org/gnome-gconf-service;1"].getService();
  }

  Components.utils.import("resource:///modules/aboutSupport.js");

  setup_accounts();

  for (let [, test] in Iterator(tests))
    test();
}
