using System.Text;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// ── Health check ──────────────────────────────────────────────────────────────
app.MapGet("/api/health", () => Results.Ok(new { status = "ok", time = DateTime.UtcNow }));

// ── Form submission ───────────────────────────────────────────────────────────
app.MapPost("/api/form-submit", async (HttpContext ctx) =>
{
    var form = await ctx.Request.ReadFormAsync();

    var formId = form["form_id"].FirstOrDefault() ?? "unknown";

    // Decode the Base64-encoded label map injected by the BeeFree form builder
    var labelMap = new Dictionary<string, string>();
    var labelsB64 = form["__field_labels"].FirstOrDefault();
    if (!string.IsNullOrEmpty(labelsB64))
    {
        try
        {
            var json = Encoding.UTF8.GetString(Convert.FromBase64String(labelsB64));
            labelMap = JsonSerializer.Deserialize<Dictionary<string, string>>(json) ?? new();
        }
        catch { /* ignore malformed label map */ }
    }

    // Build labeled field list — skip internal hidden fields and submit button
    var labeled = form.Keys
        .Where(k => k != "form_id" && k != "__field_labels" && k != "submit_button")
        .Select(k => new
        {
            field = k,
            label = labelMap.TryGetValue(k, out var l) ? l : k,
            value = form[k].FirstOrDefault() ?? string.Empty
        })
        .ToList();

    var submissionId = $"sub_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
    var timestamp    = DateTime.Now;

    Console.WriteLine($"[Form Submit] form_id={formId} | sub={submissionId}");
    labeled.ForEach(x => Console.WriteLine($"  {x.label}: {x.value}"));

    return Results.Content(SuccessPage(formId, submissionId, timestamp), "text/html");
});

app.Run();

// ── Success page ──────────────────────────────────────────────────────────────
// $$""" uses double-brace {{...}} for interpolation, so single { } in CSS are treated as literals
static string SuccessPage(string formId, string submissionId, DateTime timestamp) => $$"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8"/>
      <title>Submitted</title>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
      <style>
        * { margin:0; padding:0; box-sizing:border-box; font-family:Inter,sans-serif; }
        body { display:flex; align-items:center; justify-content:center; min-height:100vh; background:#F8FAFC; }
        .card { background:white; padding:48px 56px; border-radius:12px; text-align:center; box-shadow:0 4px 24px rgba(0,0,0,.08); max-width:460px; width:90%; }
        .check { width:64px; height:64px; background:#ECFDF5; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 20px; font-size:30px; }
        h1 { font-size:22px; color:#1E293B; margin-bottom:10px; }
        p  { font-size:14px; color:#64748B; line-height:1.7; }
        .meta { margin-top:16px; padding:12px 16px; background:#F8FAFC; border-radius:8px; font-size:12px; color:#64748B; text-align:left; }
        .meta strong { color:#374151; }
        a { display:inline-block; margin-top:24px; padding:10px 28px; background:#6366F1; color:white; border-radius:7px; text-decoration:none; font-size:13px; font-weight:500; }
        a:hover { background:#4F46E5; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="check">&#10003;</div>
        <h1>Submitted Successfully</h1>
        <p>Your response has been recorded.</p>
        <div class="meta">
          <strong>Form ID:</strong> {{formId}}<br/>
          <strong>Submission ID:</strong> {{submissionId}}<br/>
          <strong>Time:</strong> {{timestamp:f}}
        </div>
        <a href="javascript:history.back()">&#8592; Go Back</a>
      </div>
    </body>
    </html>
    """;
