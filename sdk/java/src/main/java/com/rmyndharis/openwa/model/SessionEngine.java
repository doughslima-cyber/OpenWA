package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** The engine a session is created on when it is not the deployment's own. */
public enum SessionEngine {
    /** A WhatsApp Cloud API session (official Meta API). */
    @SerializedName("meta-cloud")
    META_CLOUD
}
