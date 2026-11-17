/** Report recorded message usage without claiming savings or unreported counts. */
export function sessionStats(events, flags) {
    let messages = 0;
    let usageReports = 0;
    let output = 0;
    let cacheReports = 0;
    let cacheRead = 0;
    let attempted = 0;
    for (const event of events) {
        if (event.type === 'assistant/attempt')
            attempted++;
        if (event.type !== 'assistant/message')
            continue;
        messages++;
        if (!event.data.usage)
            continue;
        usageReports++;
        output += event.data.usage.outputTokens;
        if (event.data.usage.cacheReadTokens !== undefined) {
            cacheReports++;
            cacheRead += event.data.usage.cacheReadTokens;
        }
    }
    const lines = [
        'DSH session usage (recorded assistant messages only)',
        `Recorded assistant messages: ${messages}`,
        `Messages with usage: ${usageReports} of ${messages}`,
        `Output tokens: ${usageReports ? output : 'unavailable'}`,
        `Cache-read tokens: ${cacheReports ? cacheRead : 'unavailable'} (${cacheReports} of ${messages} messages reported cache reads)`,
        `Uncommitted assistant attempts excluded: ${attempted}`,
        'Savings: unknown (no comparison without Caveman)',
    ];
    if (flags)
        lines.push('Options are not supported in DSH; this report covers the current session only.');
    return lines.join('\n');
}
