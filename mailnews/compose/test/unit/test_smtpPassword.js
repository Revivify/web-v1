/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/**
 * Authentication tests for SMTP.
 */

Components.utils.import("resource:///modules/mailServices.js");

load("../../../resources/passwordStorage.js");

var server;

const kSender = "from@foo.invalid";
const kTo = "to@foo.invalid";
const kUsername = "testsmtp";
// This is the same as in the signons file.
const kPassword = "smtptest";

function run_test() {
  function createHandler(d) {
    var handler = new SMTP_RFC2821_handler(d);
    // Username needs to match signons.txt
    handler.kUsername = kUsername;
    handler.kPassword = kPassword;
    handler.kAuthRequired = true;
    return handler;
  }
  server = setupServerDaemon(createHandler);

  // Prepare files for passwords (generated by a script in bug 925489).
  setupForPassword("signons-mailnews1.8.sqlite")

  // Test file
  var testFile = do_get_file("data/message1.eml");

  // Ensure we have at least one mail account
  localAccountUtils.loadLocalMailAccount();

  // Handle the server in a try/catch/finally loop so that we always will stop
  // the server if something fails.
  try {
    // Start the fake SMTP server
    server.start();
    var smtpServer = getBasicSmtpServer(server.port);
    var identity = getSmtpIdentity(kSender, smtpServer);

    // This time with auth
    test = "Auth sendMailMessage";

    smtpServer.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
    smtpServer.socketType = Ci.nsMsgSocketType.plain;
    smtpServer.username = kUsername;

    MailServices.smtp.sendMailMessage(testFile, kTo, identity,
                                      null, null, null, null,
                                      false, {}, {});

    server.performTest();

    var transaction = server.playTransaction();
    do_check_transaction(transaction, ["EHLO test",
                                       "AUTH PLAIN " + AuthPLAIN.encodeLine(kUsername, kPassword),
                                       "MAIL FROM:<" + kSender + "> SIZE=155",
                                       "RCPT TO:<" + kTo + ">",
                                       "DATA"]);

  } catch (e) {
    do_throw(e);
  } finally {
    server.stop();
  
    var thread = gThreadManager.currentThread;
    while (thread.hasPendingEvents())
      thread.processNextEvent(true);
  }
}
