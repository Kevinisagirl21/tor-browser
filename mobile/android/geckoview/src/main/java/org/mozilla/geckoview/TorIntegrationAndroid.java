/* -*- Mode: Java; c-basic-offset: 4; tab-width: 20; indent-tabs-mode: nil; -*-
 * vim: ts=4 sw=4 expandtab:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.geckoview;

import android.content.Context;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.mozilla.gecko.EventDispatcher;
import org.mozilla.gecko.GeckoAppShell;
import org.mozilla.gecko.util.BundleEventListener;
import org.mozilla.gecko.util.EventCallback;
import org.mozilla.gecko.util.GeckoBundle;

/* package */ class TorIntegrationAndroid implements BundleEventListener {
    private static final String TAG = "TorIntegrationAndroid";

    private static final String TOR_EVENT_START = "GeckoView:Tor:StartTor";
    private static final String TOR_EVENT_STOP = "GeckoView:Tor:StopTor";
    private static final String MEEK_EVENT_START = "GeckoView:Tor:StartMeek";
    private static final String MEEK_EVENT_STOP = "GeckoView:Tor:StopMeek";

    private static final String CONTROL_PORT_FILE = "/control-ipc";
    private static final String SOCKS_FILE = "/socks-ipc";
    private static final String COOKIE_AUTH_FILE = "/auth-file";

    private final String mLibraryDir;
    private final Path mCacheDir;
    private final String mIpcDirectory;
    private final String mDataDir;

    private TorProcess mTorProcess = null;
    /**
     * The first time we run a Tor process in this session, we copy some configuration files to be
     * sure we always have the latest version, but if we re-launch a tor process we do not need to
     * copy them again.
     */
    private boolean mCopiedConfigFiles = false;
    /**
     * Allow multiple proxies to be started, even though it might not actually happen.
     * The key should be positive (also 0 is not allowed).
     */
    private final HashMap<Integer, MeekTransport> mMeeks = new HashMap<>();
    private int mMeekCounter;

    public TorIntegrationAndroid(Context context) {
        mLibraryDir = context.getApplicationInfo().nativeLibraryDir;
        mCacheDir = context.getCacheDir().toPath();
        mIpcDirectory = mCacheDir + "/tor-private";
        mDataDir = context.getDataDir().getAbsolutePath() + "/tor";
        registerListener();
    }

    public synchronized void shutdown() {
        // FIXME: It seems this never gets called
        if (mTorProcess != null) {
            mTorProcess.shutdown();
            mTorProcess = null;
        }
    }

    private void registerListener() {
        EventDispatcher.getInstance()
                .registerUiThreadListener(
                        this,
                        TOR_EVENT_START,
                        MEEK_EVENT_START,
                        MEEK_EVENT_STOP);
    }

    @Override // BundleEventListener
    public synchronized void handleMessage(
            final String event, final GeckoBundle message, final EventCallback callback) {
        if (TOR_EVENT_START.equals(event)) {
            startDaemon(message, callback);
        } else if (TOR_EVENT_STOP.equals(event)) {
            stopDaemon(message, callback);
        } else if (MEEK_EVENT_START.equals(event)) {
            startMeek(message, callback);
        } else if (MEEK_EVENT_STOP.equals(event)) {
            stopMeek(message, callback);
        }
    }

    private synchronized void startDaemon(final GeckoBundle message, final EventCallback callback) {
        // Let JS generate this to possibly reduce the chance of race conditions.
        String handle = message.getString("handle", "");
        if (handle.isEmpty()) {
            Log.e(TAG, "Requested to start a tor process without a handle.");
            callback.sendError("Expected a handle for the new process.");
            return;
        }
        Log.d(TAG, "Starting the a tor process with handle " + handle);

        TorProcess previousProcess = mTorProcess;
        if (previousProcess != null) {
            Log.w(TAG, "We still have a running process: " + previousProcess.getHandle());
        }
        mTorProcess = new TorProcess(handle);

        GeckoBundle bundle = new GeckoBundle(3);
        bundle.putString("controlPortPath", mIpcDirectory + CONTROL_PORT_FILE);
        bundle.putString("socksPath", mIpcDirectory + SOCKS_FILE);
        bundle.putString("cookieFilePath", mIpcDirectory + COOKIE_AUTH_FILE);
        callback.sendSuccess(bundle);
    }

    private synchronized void stopDaemon(final GeckoBundle message, final EventCallback callback) {
        if (mTorProcess == null) {
            if (callback != null) {
                callback.sendSuccess(null);
            }
            return;
        }
        String handle = message.getString("handle", "");
        if (!mTorProcess.getHandle().equals(handle)) {
            GeckoBundle bundle = new GeckoBundle(1);
            bundle.putString("error", "The requested process has not been found. It might have already been stopped.");
            callback.sendError(bundle);
            return;
        }
        mTorProcess.shutdown();
        mTorProcess = null;
        callback.sendSuccess(null);
    }

    class TorProcess extends Thread {
        private static final String TOR_EVENT_STARTED = "GeckoView:Tor:TorStarted";
        private static final String TOR_EVENT_START_FAILED = "GeckoView:Tor:TorStartFailed";
        private static final String TOR_EVENT_EXITED = "GeckoView:Tor:TorExited";
        private final String mHandle;
        private Process mProcess = null;

        TorProcess(String handle) {
            mHandle = handle;
            setName("tor-process-" + handle);
            start();
        }

        @Override
        public void run() {
            cleanIpcDirectory();

            final String ipcDir = TorIntegrationAndroid.this.mIpcDirectory;
            final ArrayList<String> args = new ArrayList<>();
            args.add(mLibraryDir + "/libTor.so");
            args.add("DisableNetwork");
            args.add("1");
            args.add("+__ControlPort");
            args.add("unix:" + ipcDir + CONTROL_PORT_FILE);
            args.add("+__SocksPort");
            args.add("unix:" + ipcDir + SOCKS_FILE + " IPv6Traffic PreferIPv6 KeepAliveIsolateSOCKSAuth");
            args.add("CookieAuthentication");
            args.add("1");
            args.add("CookieAuthFile");
            args.add(ipcDir + COOKIE_AUTH_FILE);
            args.add("DataDirectory");
            args.add(mDataDir);
            boolean copied = true;
            try {
                copyAndUseConfigFile("--defaults-torrc", "torrc-defaults", args);
            } catch (IOException e) {
                Log.w(TAG, "torrc-default cannot be created, pluggable transports will not be available", e);
                copied = false;
            }
            try {
                copyAndUseConfigFile("GeoIPFile", "geoip", args);
                copyAndUseConfigFile("GeoIPv6File", "geoip6", args);
            } catch (IOException e) {
                Log.w(TAG, "GeoIP files cannot be created, this feature will not be available.", e);
                copied = false;
            }
            mCopiedConfigFiles = copied;

            Log.d(TAG, "Starting tor with the follwing args: " + args.toString());
            final ProcessBuilder builder = new ProcessBuilder(args);
            builder.directory(new File(mLibraryDir));
            try {
                mProcess = builder.start();
            } catch (IOException e) {
                Log.e(TAG, "Cannot start tor " + mHandle, e);
                final GeckoBundle data = new GeckoBundle(2);
                data.putString("handle", mHandle);
                data.putString("error", e.getMessage());
                EventDispatcher.getInstance().dispatch(TOR_EVENT_START_FAILED, data);
                return;
            }
            Log.i(TAG, "Tor process " + mHandle + " started.");
            {
                final GeckoBundle data = new GeckoBundle(1);
                data.putString("handle", mHandle);
                EventDispatcher.getInstance().dispatch(TOR_EVENT_STARTED, data);
            }
            try {
                BufferedReader reader = new BufferedReader(new InputStreamReader(mProcess.getInputStream()));
                String line;
                while ((line = reader.readLine()) != null) {
                    Log.i(TAG, "[tor-" + mHandle + "] " + line);
                }
            } catch (IOException e) {
                Log.e(TAG, "Failed to read stdout of the tor process " + mHandle, e);
            }
            Log.d(TAG, "Exiting the stdout loop for process " + mHandle);
            final GeckoBundle data = new GeckoBundle(2);
            data.putString("handle", mHandle);
            try {
                data.putInt("status", mProcess.waitFor());
            } catch (InterruptedException e) {
                Log.e(TAG, "Failed to wait for the tor process " + mHandle, e);
                data.putInt("status", 0xdeadbeef);
            }
            // FIXME: We usually don't reach this when the application is killed!
            // So, we don't do our cleanup.
            Log.i(TAG, "Tor process " + mHandle + " has exited.");
            EventDispatcher.getInstance().dispatch(TOR_EVENT_EXITED, data);
        }

        private void cleanIpcDirectory() {
            File directory = new File(TorIntegrationAndroid.this.mIpcDirectory);
            if (!Files.isDirectory(directory.toPath())) {
                if (!directory.mkdirs()) {
                    Log.e(TAG, "Failed to create the IPC directory.");
                    return;
                }
                try {
                    Set<PosixFilePermission> chmod = PosixFilePermissions.fromString("rwx------");
                    Files.setPosixFilePermissions(directory.toPath(), chmod);
                } catch (IOException e) {
                    Log.e(TAG, "Could not set the permissions to the IPC directory.", e);
                }
                return;
            }
            // We assume we do not have child directories, only files
            File[] maybeFiles = directory.listFiles();
            if (maybeFiles != null) {
                for (File file : maybeFiles) {
                    if (!file.delete()) {
                        Log.d(TAG, "Could not delete " + file);
                    }
                }
            }
        }

        private void copyAndUseConfigFile(String option, String name, ArrayList<String> args) throws IOException {
            final Path path = Paths.get(mCacheDir.toFile().getAbsolutePath(), name);
            if (!mCopiedConfigFiles || !path.toFile().exists()) {
                final Context context = GeckoAppShell.getApplicationContext();
                final InputStream in = context.getAssets().open("common/" + name);
                Files.copy(in, path, StandardCopyOption.REPLACE_EXISTING);
                in.close();
            }
            args.add(option);
            args.add(path.toString());
        }

        public void shutdown() {
            if (mProcess != null && mProcess.isAlive()) {
                mProcess.destroy();
            }
            if (isAlive()) {
                try {
                    join();
                } catch (InterruptedException e) {
                    Log.e(TAG, "Cannot join the thread for tor process " + mHandle + ", possibly already terminated", e);
                }
            }
        }

        public String getHandle() {
            return mHandle;
        }
    }

    private synchronized void startMeek(final GeckoBundle message, final EventCallback callback) {
        if (callback == null) {
            Log.e(TAG, "Tried to start Meek without a callback.");
            return;
        }
        mMeekCounter++;
        mMeeks.put(new Integer(mMeekCounter), new MeekTransport(callback, mMeekCounter));
    }

    private synchronized void stopMeek(final GeckoBundle message, final EventCallback callback) {
        final Integer key = message.getInteger("id");
        final MeekTransport meek = mMeeks.remove(key);
        if (meek != null) {
            meek.shutdown();
        }
        if (callback != null) {
            callback.sendSuccess(null);
        }
    }

    private class MeekTransport extends Thread {
        private static final String TRANSPORT = "meek_lite";
        private Process mProcess;
        private final EventCallback mCallback;
        private final int mId;

        MeekTransport(final EventCallback callback, int id) {
            setName("meek-" + id);
            final ProcessBuilder builder = new ProcessBuilder(mLibraryDir + "/libObfs4proxy.so");
            {
                final Map<String, String> env = builder.environment();
                env.put("TOR_PT_MANAGED_TRANSPORT_VER", "1");
                env.put("TOR_PT_STATE_LOCATION", mDataDir + "/pt_state");
                env.put("TOR_PT_EXIT_ON_STDIN_CLOSE", "1");
                env.put("TOR_PT_CLIENT_TRANSPORTS", TRANSPORT);
            }
            mCallback = callback;
            mId = id;
            try {
                // We expect this process to be short-lived, therefore we do not bother with
                // implementing this as a service.
                mProcess = builder.start();
            } catch (IOException e) {
                Log.e(TAG, "Cannot start the PT", e);
                callback.sendError(e.getMessage());
                return;
            }
            start();
        }

        /**
         * Parse the standard output of the pluggable transport to find the hostname and port it is
         * listening on.
         * <p>
         * See also the specs for the IPC protocol at https://spec.torproject.org/pt-spec/ipc.html.
         */
        @Override
        public void run() {
            final String PROTOCOL_VERSION = "1";
            String hostname = "";
            boolean valid = false;
            int port = 0;
            String error = "Did not see a CMETHOD";
            try {
                InputStreamReader isr = new InputStreamReader(mProcess.getInputStream());
                BufferedReader reader = new BufferedReader(isr);
                String line;
                while ((line = reader.readLine()) != null) {
                    line = line.trim();
                    Log.d(TAG, "Meek line: " + line);
                    // Split produces always at least one item
                    String[] tokens = line.split(" ");
                    if ("VERSION".equals(tokens[0]) && (tokens.length != 2 || !PROTOCOL_VERSION.equals(tokens[1]))) {
                        error = "Bad version: " + line;
                        break;
                    }
                    if ("CMETHOD".equals(tokens[0])) {
                        if (tokens.length != 4) {
                            error = "Bad number of tokens in CMETHOD: " + line;
                            break;
                        }
                        if (!tokens[1].equals(TRANSPORT)) {
                            error = "Unexpected transport: " + tokens[1];
                            break;
                        }
                        if (!"socks5".equals(tokens[2])) {
                            error = "Unexpected proxy type: " + tokens[2];
                            break;
                        }
                        String[] addr = tokens[3].split(":");
                        if (addr.length != 2) {
                            error = "Invalid address";
                            break;
                        }
                        hostname = addr[0];
                        try {
                            port = Integer.parseInt(addr[1]);
                        } catch (NumberFormatException e) {
                            error = "Invalid port: " + e.getMessage();
                            break;
                        }
                        if (port < 1 || port > 65535) {
                            error = "Invalid port: out of bounds";
                            break;
                        }
                        valid = true;
                        break;
                    }
                    if (tokens[0].endsWith("-ERROR")) {
                        error = "Seen an error: " + line;
                        break;
                    }
                }
            } catch (Exception e) {
                error = e.getMessage();
            }
            if (valid) {
                Log.d(TAG, "Setup a meek transport " + mId + ": " + hostname + ":" + port);
                final GeckoBundle bundle = new GeckoBundle(3);
                bundle.putInt("id", mId);
                bundle.putString("address", hostname);
                bundle.putInt("port", port);
                mCallback.sendSuccess(bundle);
            } else {
                Log.e(TAG, "Failed to get a usable config from the PT: " + error);
                mCallback.sendError(error);
            }
        }

        void shutdown() {
            if (mProcess != null) {
                mProcess.destroy();
                mProcess = null;
            }
            try {
                join();
            } catch (InterruptedException e) {
                Log.e(TAG, "Could not join the meek thread", e);
            }
        }
    }
}
