/* -*- Mode: Java; c-basic-offset: 4; tab-width: 4; indent-tabs-mode: nil; -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.gecko.torbootstrap;

import android.app.Activity;
import android.content.Intent;
import android.graphics.drawable.Animatable2;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.Bundle;
import android.support.v4.app.Fragment;
import android.support.v4.content.LocalBroadcastManager;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.TextView;
import android.util.Log;
import org.mozilla.gecko.R;
import org.mozilla.gecko.Telemetry;
import org.mozilla.gecko.TelemetryContract;
import org.mozilla.gecko.firstrun.FirstrunPanel;

import org.torproject.android.service.OrbotConstants;
import org.torproject.android.service.TorService;
import org.torproject.android.service.TorServiceConstants;
import org.torproject.android.service.util.TorServiceUtils;


/**
 * Tor Bootstrap panel (fragment/screen)
 *
 * This is based on the Firstrun Panel for simplicity.
 */
public class TorBootstrapPanel extends FirstrunPanel implements TorBootstrapLogger {

    protected static final String LOGTAG = "TorBootstrap";

    protected ViewGroup mRoot;
    protected Activity mActContext;
    protected TorBootstrapPager.TorBootstrapController mBootstrapController;

    // These are used by the background AlphaChanging thread for dynamically changing
    // the alpha value of the Onion during bootstrap.
    private int mOnionCurrentAlpha = 255;
    // This is either +1 or -1, depending on the direction of the change.
    private int mOnionCurrentAlphaDirection = -1;
    private Object mOnionAlphaChangerLock = new Object();
    private boolean mOnionAlphaChangerRunning = false;

    // Runnable for changing the alpha of the Onion image every 100 milliseconds.
    // It gradually increases and then decreases the alpha in the background and
    // then applies the new alpha on the UI thread.
    private Thread mChangeOnionAlphaThread = null;
    final private class ChangeOnionAlphaRunnable implements Runnable {
        @Override
        public void run() {
            while (true) {
                 synchronized(mOnionAlphaChangerLock) {
                     if (!mOnionAlphaChangerRunning) {
                         // Null the reference for this thread when we exit
                         mChangeOnionAlphaThread = null;
                         return;
                     }
                 }

                 // Choose the new value here, mOnionCurrentAlpha is set in setOnionAlphaValue()
                 // Increase by 5 if mOnionCurrentAlphaDirection is positive, and decrease by
                 // 5 if mOnionCurrentAlphaDirection is negative.
                 final int newAlpha = mOnionCurrentAlpha + mOnionCurrentAlphaDirection*5;
                 getActivity().runOnUiThread(new Runnable() {
                      public void run() {
                          setOnionAlphaValue(newAlpha);
                      }
                 });

                 try {
                     Thread.sleep(100);
                 } catch (InterruptedException e) {}
            }
        }
    }

    @Override
    public View onCreateView(LayoutInflater inflater, ViewGroup container, Bundle savedInstance) {
        mRoot = (ViewGroup) inflater.inflate(R.layout.tor_bootstrap, container, false);
        if (mRoot == null) {
            Log.w(LOGTAG, "Inflating R.layout.tor_bootstrap returned null");
            return null;
        }

        Button connectButton = mRoot.findViewById(R.id.tor_bootstrap_connect);
        if (connectButton == null) {
            Log.w(LOGTAG, "Finding the Connect button failed. Did the ID change?");
            return null;
        }

        connectButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startBootstrapping();
            }
        });

        // This should be declared in the xml layout, however there is a bug
        // preventing this (the XML attribute isn't actually defined in the
        // SDK).
        // https://issuetracker.google.com/issues/37036728
        connectButton.setClipToOutline(true);

        configureGearCogClickHandler();

        TorLogEventListener.addLogger(this);

        return mRoot;
    }

    private void setOnionAlphaValue(int newAlpha) {
        ImageView onionImg = (ImageView) mRoot.findViewById(R.id.tor_bootstrap_onion);
        if (onionImg == null) {
            return;
        }

        if (newAlpha > 255) {
            // Cap this at 255 and change direction of animation
            newAlpha = 255;

            synchronized(mOnionAlphaChangerLock) {
                mOnionCurrentAlphaDirection = -1;
            }
        } else if (newAlpha < 0) {
            // Lower-bound this at 0 and change direction of animation
            newAlpha = 0;

            synchronized(mOnionAlphaChangerLock) {
                mOnionCurrentAlphaDirection = 1;
            }
        }
        onionImg.setImageAlpha(newAlpha);
        mOnionCurrentAlpha = newAlpha;
    }

    public void updateStatus(String torServiceMsg, String newTorStatus) {
        final String noticePrefix = "NOTICE: ";

        if (torServiceMsg == null) {
            return;
        }

        TextView torLog = (TextView) mRoot.findViewById(R.id.tor_bootstrap_last_status_message);
        if (torLog == null) {
            Log.w(LOGTAG, "updateStatus: torLog is null?");
        }
        // Only show Notice-level log messages on this panel
        if (torServiceMsg.startsWith(noticePrefix)) {
            // Drop the prefix
            String msg = torServiceMsg.substring(noticePrefix.length());
            torLog.setText(msg);
        } else if (torServiceMsg.toLowerCase().contains("error")) {
            torLog.setText(R.string.tor_notify_user_about_error);

            // This may be a false-positive, but if we encountered an error within
            // the OrbotService then there's likely nothing the user can do. This
            // isn't persistent, so if they restart the app the button will be
            // visible again.
            Button connectButton = mRoot.findViewById(R.id.tor_bootstrap_connect);
            if (connectButton == null) {
                Log.w(LOGTAG, "updateStatus: Finding the Connect button failed. Did the ID change?");
            } else {
                TextView swipeLeftLog = (TextView) mRoot.findViewById(R.id.tor_bootstrap_swipe_log);
                if (swipeLeftLog == null) {
                    Log.w(LOGTAG, "updateStatus: swipeLeftLog is null?");
                }

                // Abuse this by showing the log message despite not bootstrapping
                toggleVisibleElements(true, torLog, connectButton, swipeLeftLog);
            }
        }

        // Return to the browser when we reach 100% bootstrapped
        if (torServiceMsg.contains(TorServiceConstants.TOR_CONTROL_PORT_MSG_BOOTSTRAP_DONE)) {
            // Inform the background AlphaChanging thread it should terminate
            synchronized(mOnionAlphaChangerLock) {
                mOnionAlphaChangerRunning = false;
            }
            close();
        }
    }

    public void setContext(Activity ctx) {
        mActContext = ctx;
    }

    // Save the TorBootstrapController.
    // This method won't be used by the main TorBootstrapPanel (|this|), but
    // it will be used by its childen.
    public void setBootstrapController(TorBootstrapPager.TorBootstrapController bootstrapController) {
        mBootstrapController = bootstrapController;
    }

    private void startTorService() {
        Intent torService = new Intent(getActivity(), TorService.class);
        torService.setAction(TorServiceConstants.ACTION_START);
        getActivity().startService(torService);
    }

    private void stopTorService() {
        // First, stop the current bootstrapping process (if it's in progress)
        // TODO Ideally, we'd DisableNetwork here, but that's not available.
        Intent torService = new Intent(getActivity(), TorService.class);
        getActivity().stopService(torService);
    }

    // Setup OnClick handler for the settings gear/cog
    protected void configureGearCogClickHandler() {
        if (mRoot == null) {
            Log.w(LOGTAG, "configureGearCogClickHandler: mRoot is null?");
            return;
        }

        final ImageView gearSettingsImage = mRoot.findViewById(R.id.tor_bootstrap_settings_gear);
        if (gearSettingsImage == null) {
            Log.w(LOGTAG, "configureGearCogClickHandler: gearSettingsImage is null?");
            return;
        }

        gearSettingsImage.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // The existance of the connect button is an indicator of the user
                // interacting with the main bootstrapping screen or the loggin screen.
                Button connectButton = mRoot.findViewById(R.id.tor_bootstrap_connect);
                if (connectButton == null) {
                    Log.w(LOGTAG, "gearSettingsImage onClick: Finding the Connect button failed, proxying request.");

                    // If there isn't a connect button on this screen, then proxy the
                    // stopBootstrapping() request via the TorBootstrapController (which
                    // is the underlying PagerAdapter).
                    mBootstrapController.stopBootstrapping();
                } else {
                    stopBootstrapping();
                }
                // Open Tor Network Settings preferences screen
                Intent intent = new Intent(mActContext, TorPreferences.class);
                mActContext.startActivity(intent);
            }
        });
    }

    private void toggleVisibleElements(boolean bootstrapping, TextView lastStatus, Button connect, TextView swipeLeft) {
        final int connectVisible = bootstrapping ? View.INVISIBLE : View.VISIBLE;
        final int infoTextVisible = bootstrapping ? View.VISIBLE : View.INVISIBLE;

        if (connect != null) {
            connect.setVisibility(connectVisible);
        }
        if (lastStatus != null) {
            lastStatus.setVisibility(infoTextVisible);
        }
        if (swipeLeft != null) {
            swipeLeft.setVisibility(infoTextVisible);
        }
    }

    private void startBackgroundAlphaChangingThread() {
        // If it is non-null, then this is a bug because the thread should null this reference when
        // it terminates.
        if (mChangeOnionAlphaThread != null) {
            if (mChangeOnionAlphaThread.getState() == Thread.State.TERMINATED) {
                // The thread likely terminated unexpectedly, null the reference.
                // The thread should set this itself.
                Log.i(LOGTAG, "mChangeOnionAlphaThread.getState(): is terminated");
                mChangeOnionAlphaThread = null;
            } else {
                // Don't null the reference in this case because then we'll start another
                // background thread. We are currently in an unknown state, simply set
                // the Running flag as false.
                Log.w(LOGTAG, "We're in an unexpected state. mChangeOnionAlphaThread.getState(): " + mChangeOnionAlphaThread.getState());

                synchronized(mOnionAlphaChangerLock) {
                    mOnionAlphaChangerRunning = false;
                }
            }
        }

        // If the background thread is not currently running, then start it.
        if (mChangeOnionAlphaThread == null) {
            mChangeOnionAlphaThread = new Thread(new ChangeOnionAlphaRunnable());
            if (mChangeOnionAlphaThread == null) {
                Log.w(LOGTAG, "Instantiating a new ChangeOnionAlphaRunnable Thread failed.");
            } else if (mChangeOnionAlphaThread.getState() == Thread.State.NEW) {
                Log.i(LOGTAG, "Starting mChangeOnionAlphaThread");

                // Synchronization across threads should not be necessary because there
                // shouldn't be any other threads relying on mOnionAlphaChangerRunning.
                // We do this purely for safety.
                synchronized(mOnionAlphaChangerLock) {
                    mOnionAlphaChangerRunning = true;
                }

                mChangeOnionAlphaThread.start();
            }
        }
    }

    public void startBootstrapping() {
        if (mRoot == null) {
            Log.w(LOGTAG, "startBootstrapping: mRoot is null?");
            return;
        }
        // We're starting bootstrap, transition into the bootstrapping-tor-panel
        Button connectButton = mRoot.findViewById(R.id.tor_bootstrap_connect);
        if (connectButton == null) {
            Log.w(LOGTAG, "startBootstrapping: connectButton is null?");
            return;
        }

        ImageView onionImg = (ImageView) mRoot.findViewById(R.id.tor_bootstrap_onion);

        // Replace the current non-animated image with the animation
        onionImg.setImageResource(R.drawable.tor_spinning_onion);

        Drawable drawableOnion = onionImg.getDrawable();
        if (Build.VERSION.SDK_INT >= 23 && drawableOnion instanceof Animatable2) {
            Animatable2 spinningOnion = (Animatable2) drawableOnion;
            // Begin spinning
            spinningOnion.start();
        } else {
            Log.i(LOGTAG, "Animatable2 is not supported (or bad inheritance), version: " + Build.VERSION.SDK_INT);
        }

        mOnionCurrentAlpha = 255;
        // The onion should have 100% alpha, begin decreasing it.
        mOnionCurrentAlphaDirection = -1;
        startBackgroundAlphaChangingThread();

        TextView torStatus = (TextView) mRoot.findViewById(R.id.tor_bootstrap_last_status_message);
        if (torStatus == null) {
            Log.w(LOGTAG, "startBootstrapping: torStatus is null?");
            return;
        }

        TextView swipeLeftLog = (TextView) mRoot.findViewById(R.id.tor_bootstrap_swipe_log);
        if (swipeLeftLog == null) {
            Log.w(LOGTAG, "startBootstrapping: swipeLeftLog is null?");
            return;
        }

        torStatus.setText(getString(R.string.tor_bootstrap_starting_status));

        toggleVisibleElements(true, torStatus, connectButton, swipeLeftLog);
        startTorService();
    }

    // This is public because this Pager may call this method if another Panel requests it.
    public void stopBootstrapping() {
        if (mRoot == null) {
            Log.w(LOGTAG, "stopBootstrapping: mRoot is null?");
            return;
        }
        // Transition from the animated bootstrapping panel to
        // the static "Connect" panel
        Button connectButton = mRoot.findViewById(R.id.tor_bootstrap_connect);
        if (connectButton == null) {
            Log.w(LOGTAG, "stopBootstrapping: connectButton is null?");
            return;
        }

        ImageView onionImg = (ImageView) mRoot.findViewById(R.id.tor_bootstrap_onion);
        if (onionImg == null) {
            Log.w(LOGTAG, "stopBootstrapping: onionImg is null?");
            return;
        }

        // Inform the background AlphaChanging thread it should terminate.
        synchronized(mOnionAlphaChangerLock) {
            mOnionAlphaChangerRunning = false;
        }

        Drawable drawableOnion = onionImg.getDrawable();

        // If the connect button wasn't pressed previously, then this object is
        // not an animation (it is most likely a BitmapDrawable). Only manipulate
        // it when it is an Animatable2.
        if (Build.VERSION.SDK_INT >= 23 && drawableOnion instanceof Animatable2) {
            Animatable2 spinningOnion = (Animatable2) drawableOnion;
            // spinningOnion is null if we didn't previously call startBootstrapping.
            // If we reach here and spinningOnion is null, then there is likely a bug
            // because stopBootstrapping() is called only when the user selects the
            // gear button and we should only reach this block if the user pressed the
            // connect button (thus creating and enabling the animation) and then
            // pressing the gear button. Therefore, if the drawableOnion is an
            // Animatable2, then spinningOnion should be non-null.
            if (spinningOnion != null) {
                spinningOnion.stop();

                onionImg.setImageResource(R.drawable.tor_spinning_onion);
            }
        } else {
            Log.i(LOGTAG, "Animatable2 is not supported (or bad inheritance), version: " + Build.VERSION.SDK_INT);
        }

        // Reset the onion's alpha value.
        onionImg.setImageAlpha(255);

        TextView torStatus = (TextView) mRoot.findViewById(R.id.tor_bootstrap_last_status_message);
        if (torStatus == null) {
            Log.w(LOGTAG, "stopBootstrapping: torStatus is null?");
            return;
        }

        TextView swipeLeftLog = (TextView) mRoot.findViewById(R.id.tor_bootstrap_swipe_log);
        if (swipeLeftLog == null) {
            Log.w(LOGTAG, "stopBootstrapping: swipeLeftLog is null?");
            return;
        }

        // Reset the displayed message
        torStatus.setText("");

        toggleVisibleElements(false, torStatus, connectButton, swipeLeftLog);
        stopTorService();
    }
}
