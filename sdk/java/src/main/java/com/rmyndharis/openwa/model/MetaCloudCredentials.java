package com.rmyndharis.openwa.model;

/** A WhatsApp Cloud API number: its Phone Number ID, its WABA ID and a system-user access token. */
public record MetaCloudCredentials(String phoneNumberId, String wabaId, String accessToken) {}
