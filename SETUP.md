# Perpay â Decagon Insights App: Setup Guide

A self-service web app for analyzing Decagon customer support conversations and publishing weekly product insights to Confluence.

## What This Does

1. You upload a Decagon CSV export in the browser
2. The app sends conversations to Claude for AI-powered analysis
3. You review the structured insights report
4. One click publishes the report to your Confluence page (appended as a new weekly section)

## Prerequisites

- A [Netlify](https://netlify.com) account (free tier works)
- An [Anthropic API key](https://console.anthropic.com/) for Claude
- An [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens) for Confluence