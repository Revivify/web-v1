/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
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
 * Mozilla Messaging.
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Jim Porter <jvporter@wisc.edu>
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

var Ci = Components.interfaces;
var Cc = Components.classes;
var Cu = Components.utils;

var elib = {};
Cu.import('resource://mozmill/modules/elementslib.js', elib);

var MODULE_NAME = 'test-attachment';

var RELATIVE_ROOT = '../shared-modules';
var MODULE_REQUIRES = ['folder-display-helpers', 'compose-helpers',
                       'window-helpers'];

var messenger;
var folder;
var epsilon;
var isWindows;
var filePrefix;

const rawAttachment =
  "Can't make the frug contest, Helen; stomach's upset. I'll fix you, " +
  "Ubik! Ubik drops you back in the thick of things fast. Taken as " +
  "directed, Ubik speeds relief to head and stomach. Remember: Ubik is " +
  "only seconds away. Avoid prolonged use.";

const b64Attachment =
  'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAYAAABWdVznAAAABHNCSVQICAgIfAhkiAAAAAlwS' +
  'FlzAAAN1wAADdcBQiibeAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAA' +
  'A5SURBVCiRY/z//z8DKYCJJNXkaGBgYGD4D8NQ5zUgiTVAxeBqSLaBkVRPM0KtIhrQ3km0jwe' +
  'SNQAAlmAY+71EgFoAAAAASUVORK5CYII=';
const b64Size = 188;

function setupModule(module) {
  let fdh = collector.getModule('folder-display-helpers');
  fdh.installInto(module);
  let ch = collector.getModule("compose-helpers");
  ch.installInto(module);
  let wh = collector.getModule('window-helpers');
  wh.installInto(module);

  folder = create_folder('ComposeAttachmentA');

  messenger = Components.classes['@mozilla.org/messenger;1']
                        .createInstance(Components.interfaces.nsIMessenger);

  isWindows = '@mozilla.org/windows-registry-key;1' in Components.classes;

  /* Today's gory details (thanks to Jonathan Protzenko): libmime somehow
   * counts the trailing newline for an attachment MIME part. Most of the time,
   * assuming attachment has N bytes (no matter what's inside, newlines or
   * not), libmime will return N + 1 bytes. On Linux and Mac, this always
   * holds. However, on Windows, if the attachment is not encoded (that is, is
   * inline text), libmime will return N + 2 bytes. Since we're dealing with
   * forwarded message data here, the bonus byte(s) appear twice.
   */
  epsilon = isWindows ? 4 : 2;
  filePrefix = isWindows ? 'file:///C:/' : 'file:///';

  // create some messages that have various types of attachments
  let messages = [
    // no attachment
    {},
    // raw attachment
    { attachments: [{ body: rawAttachment,
                      filename: 'ubik.txt',
                      format: '' }]},
    // b64-encoded image attachment
    { attachments: [{ body: b64Attachment,
                      contentType: 'image/png',
                      filename: 'lines.png',
                      encoding: 'base64',
                      format: '' }]},
    ];

  for (let i=0; i<messages.length; i++) {
    add_message_to_folder(folder, create_message(messages[i]));
  }
}

/**
 * Make sure that the attachment's size is what we expect
 * @param controller the controller for the compose window
 * @param index the attachment to examine, as an index into the listbox
 * @param expectedSize the expected size of the attachment, in bytes
 */
function check_attachment_size(controller, index, expectedSize) {
  let bucket = controller.e('attachmentBucket');
  let node = bucket.getElementsByTagName('listitem')[index];

  // First, let's check that the 'attachmentSize' attribute is correct
  let size = node.attachment.size;
  if (Math.abs(size - expectedSize) > epsilon)
    throw new Error('Reported attachment size ('+size+') not within epsilon ' +
                    'of actual attachment size ('+expectedSize+')');

  // Next, make sure that the formatted size in the label is correct
  let formattedSize = /\((.*?)\)$/.exec(node.getAttribute('label'))[1];
  let expectedFormattedSize = messenger.formatFileSize(size);
  if (formattedSize != expectedFormattedSize)
    throw new Error('Formatted attachment size ('+formattedSize+') does not ' +
                    'match expected value ('+expectedFormattedSize+')');
}

/**
 * Make sure that the attachment's size is not displayed
 * @param controller the controller for the compose window
 * @param index the attachment to examine, as an index into the listbox
 */
function check_no_attachment_size(controller, index) {
  let bucket = controller.e('attachmentBucket');
  let node = bucket.getElementsByTagName('listitem')[index];

  if (node.attachment.size != -1)
    throw new Error('attachment.size attribute should be -1!');

  if (/\((.*?)\)$/.exec(node.getAttribute('label')))
    throw new Error('Attachment size should not be displayed!');
}

/**
 * Make sure that the total size of all attachments is what we expect.
 * @param controller the controller for the compose window
 * @param count the expected number of attachments
 */
function check_total_attachment_size(controller, count) {
  let bucket = controller.e("attachmentBucket");
  let nodes = bucket.getElementsByTagName("listitem");
  let sizeNode = controller.e("attachmentBucketSize");

  if (nodes.length != count)
    throw new Error("Saw "+nodes.length+" attachments, but expected "+count);

  let size = 0;
  for (let i = 0; i < nodes.length; i++) {
    let currSize = nodes[i].attachment.size;
    if (currSize != -1)
      size += currSize;
  }

  // Next, make sure that the formatted size in the label is correct
  let formattedSize = sizeNode.getAttribute("value");
  let expectedFormattedSize = messenger.formatFileSize(size);
  if (formattedSize != expectedFormattedSize)
    throw new Error("Formatted attachment size ("+formattedSize+") does not " +
                    "match expected value ("+expectedFormattedSize+")");
}

function test_file_attachment() {
  let cwc = open_compose_new_mail();

  let url = filePrefix + "some/file/here.txt";
  let size = 1234;

  add_attachment(cwc, url, size);
  check_attachment_size(cwc, 0, size);
  check_total_attachment_size(cwc, 1);

  close_compose_window(cwc);
}

function test_webpage_attachment() {
  let cwc = open_compose_new_mail();

  add_attachment(cwc, "http://www.mozillamessaging.com/");
  check_no_attachment_size(cwc, 0);
  check_total_attachment_size(cwc, 1);

  close_compose_window(cwc);
}

function test_multiple_attachments() {
  let cwc = open_compose_new_mail();

  let files = [{name: "foo.txt", size: 1234},
               {name: "bar.txt", size: 5678},
               {name: "baz.txt", size: 9012}];
  for (let i = 0; i < files.length; i++) {
    add_attachment(cwc, filePrefix+files[i].name, files[i].size);
    check_attachment_size(cwc, i, files[i].size);
  }

  check_total_attachment_size(cwc, files.length);
  close_compose_window(cwc);
}

function test_delete_attachments() {
  let cwc = open_compose_new_mail();

  let files = [{name: "foo.txt", size: 1234},
               {name: "bar.txt", size: 5678},
               {name: "baz.txt", size: 9012}];
  for (let i = 0; i < files.length; i++) {
    add_attachment(cwc, filePrefix+files[i].name, files[i].size);
    check_attachment_size(cwc, i, files[i].size);
  }

  delete_attachment(cwc, 0);
  check_total_attachment_size(cwc, files.length-1);

  close_compose_window(cwc);
}

function subtest_rename_attachment(cwc) {
  cwc.e("loginTextbox").value = "renamed.txt";
  cwc.window.document.documentElement.getButton('accept').doCommand();
}

function test_rename_attachment() {
  let cwc = open_compose_new_mail();

  let url = filePrefix + "some/file/here.txt";
  let size = 1234;

  add_attachment(cwc, url, size);

  // Now, rename the attachment.
  let bucket = cwc.e("attachmentBucket");
  let node = bucket.getElementsByTagName("listitem")[0];
  cwc.click(new elib.Elem(node));
  plan_for_modal_dialog("commonDialog", subtest_rename_attachment);
  cwc.window.RenameSelectedAttachment();
  wait_for_modal_dialog("commonDialog");

  check_attachment_size(cwc, 0, size);
  check_total_attachment_size(cwc, 1);

  close_compose_window(cwc);
}

function test_forward_raw_attachment() {
  be_in_folder(folder);
  let curMessage = select_click_row(1);

  let cwc = open_compose_with_forward();
  check_attachment_size(cwc, 0, rawAttachment.length);
  check_total_attachment_size(cwc, 1);

  close_compose_window(cwc);
}

function test_forward_b64_attachment() {
  be_in_folder(folder);
  let curMessage = select_click_row(2);

  let cwc = open_compose_with_forward();
  check_attachment_size(cwc, 0, b64Size);
  check_total_attachment_size(cwc, 1);

  close_compose_window(cwc);
}

function test_forward_message_as_attachment() {
  be_in_folder(folder);
  let curMessage = select_click_row(0);

  let cwc = open_compose_with_forward_as_attachments();
  check_attachment_size(cwc, 0, curMessage.messageSize);
  check_total_attachment_size(cwc, 1);

  close_compose_window(cwc);
}

function test_forward_message_with_attachments_as_attachment() {
  be_in_folder(folder);
  let curMessage = select_click_row(1);

  let cwc = open_compose_with_forward_as_attachments();
  check_attachment_size(cwc, 0, curMessage.messageSize);
  check_total_attachment_size(cwc, 1);

  close_compose_window(cwc);
}

// XXX: Test attached emails dragged onto composer and files pulled from other
// emails (this probably requires better drag-and-drop support from Mozmill)
