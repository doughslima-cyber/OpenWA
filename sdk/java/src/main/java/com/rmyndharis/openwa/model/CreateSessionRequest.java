package com.rmyndharis.openwa.model;

import java.util.Map;

/**
 * Request body for creating a session. Requires an OPERATOR-level key; setting {@code proxyUrl}
 * requires an ADMIN key.
 */
public record CreateSessionRequest(
    String name,
    Map<String, Object> config,
    String proxyUrl,
    ProxyType proxyType,
    SessionEngine engine,
    MetaCloudCredentials metaCloud
) {
    /** The constructor from before {@code engine} and {@code metaCloud}, kept so existing callers compile. */
    public CreateSessionRequest(String name, Map<String, Object> config, String proxyUrl, ProxyType proxyType) {
        this(name, config, proxyUrl, proxyType, null, null);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String name;
        private Map<String, Object> config;
        private String proxyUrl;
        private ProxyType proxyType;
        private SessionEngine engine;
        private MetaCloudCredentials metaCloud;

        /** Alphanumeric + hyphens, 3–50 chars. */
        public Builder name(String v) {
            this.name = v;
            return this;
        }

        public Builder config(Map<String, Object> v) {
            this.config = v;
            return this;
        }

        /** Requires an ADMIN key; the gateway answers 403 otherwise. */
        public Builder proxyUrl(String v) {
            this.proxyUrl = v;
            return this;
        }

        /** Deprecated and ignored by the server: the proxyUrl scheme selects the proxy protocol. */
        @Deprecated
        public Builder proxyType(ProxyType v) {
            this.proxyType = v;
            return this;
        }

        /** {@code meta-cloud} for a WhatsApp Cloud API session (needs META_CLOUD_ENABLED=true); omit for the deployment engine. */
        public Builder engine(SessionEngine v) {
            this.engine = v;
            return this;
        }

        /** The Cloud API number of a {@code meta-cloud} session. */
        public Builder metaCloud(MetaCloudCredentials v) {
            this.metaCloud = v;
            return this;
        }

        public CreateSessionRequest build() {
            return new CreateSessionRequest(name, config, proxyUrl, proxyType, engine, metaCloud);
        }
    }
}
