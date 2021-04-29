// Copyright (c) 2021, The Tor Project, Inc.

var EXPORTED_SYMBOLS = ["TorConnectChild"];

const { RemotePageChild } = ChromeUtils.import(
  "resource://gre/actors/RemotePageChild.jsm"
);

class TorConnectChild extends RemotePageChild {}
