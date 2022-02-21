// Copyright (c) 2022, The Tor Project, Inc.

"use strict";

var EXPORTED_SYMBOLS = ["RulesetsChild"];

const { RemotePageChild } = ChromeUtils.import(
  "resource://gre/actors/RemotePageChild.jsm"
);

class RulesetsChild extends RemotePageChild {}
