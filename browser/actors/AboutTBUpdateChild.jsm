// Copyright (c) 2020, The Tor Project, Inc.
// See LICENSE for licensing information.
//
// vim: set sw=2 sts=2 ts=8 et syntax=javascript:

var EXPORTED_SYMBOLS = ["AboutTBUpdateChild"];

const { RemotePageChild } = ChromeUtils.import(
  "resource://gre/actors/RemotePageChild.jsm"
);

class AboutTBUpdateChild extends RemotePageChild {}
