// The Heddohon plugin for Navidrome.
//
// Navidrome calls a scrobbler plugin for every play of a user assigned to it,
// whichever client made the play. This one posts each play to Heddohon, which
// keeps the listening history, and what each client is playing now, which
// Heddohon shows the user's own browsers. Every 15 seconds it also asks
// Heddohon whether an account has asked for its scrobble history, and sends
// it when one has.
//
// A plugin cannot be called from outside Navidrome, so every exchange starts
// here. Navidrome makes a new instance for each call and nothing is kept
// between two of them: where an import has got to is held by Heddohon, which
// names the next timestamp it wants in each answer.
package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/navidrome/navidrome/plugins/pdk/go/host"
	"github.com/navidrome/navidrome/plugins/pdk/go/lifecycle"
	"github.com/navidrome/navidrome/plugins/pdk/go/pdk"
	"github.com/navidrome/navidrome/plugins/pdk/go/scheduler"
	"github.com/navidrome/navidrome/plugins/pdk/go/scrobbler"
)

const (
	// The version of the messages below, which Heddohon refuses when it does not know it.
	protocol = 1
	endpoint = "/api/plugin/navidrome"

	pollSchedule = "heddohon-poll"
	// The longest an account waits for its import to start.
	pollEvery = "@every 15s"

	// Scrobbles sent in one request. At about 50 bytes each a page is 50KB,
	// under the 512KB Heddohon reads of a request body.
	historyPage = 1000
	// Navidrome ends a call after 30 seconds. No page is started later than
	// this into one, which leaves a request its whole timeout.
	callBudget     = 15 * time.Second
	requestTimeout = 10 * time.Second
)

type play struct {
	// Only on a play as it happens. A page of history names its user once.
	Username string `json:"username,omitempty"`
	SongID   string `json:"songId"`
	// Unix seconds.
	At int64 `json:"at"`
}

type message struct {
	V    int    `json:"v"`
	Type string `json:"type"`
	// For "history": whose it is, whether more follows, and whether Navidrome refused to read it.
	Username string `json:"username,omitempty"`
	Plays    []play `json:"plays,omitempty"`
	More     bool   `json:"more,omitempty"`
	Failed   bool   `json:"failed,omitempty"`
	// For "playback", with the user name: the track a client is on, what it is
	// doing with it (starting, playing, paused, stopped or expired), and the
	// client, by Navidrome's id for it and the name it gives.
	SongID     string `json:"songId,omitempty"`
	State      string `json:"state,omitempty"`
	PositionMs int64  `json:"positionMs,omitempty"`
	Player     string `json:"player,omitempty"`
	PlayerName string `json:"playerName,omitempty"`
}

// An account whose history Heddohon is waiting for, from this timestamp on.
type want struct {
	Username string `json:"username"`
	From     int64  `json:"from"`
}

type answer struct {
	Wanted []want `json:"wanted"`
}

type settings struct {
	url    string
	origin string
	token  string
}

// The plugin's configuration, or false while the address or the token is missing or unusable.
func configured() (settings, bool) {
	raw, _ := pdk.GetConfig("url")
	token, _ := pdk.GetConfig("token")
	origin, _ := pdk.GetConfig("origin")
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	token = strings.TrimSpace(token)
	if raw == "" || token == "" {
		return settings{}, false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return settings{}, false
	}
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	if origin == "" {
		origin = parsed.Scheme + "://" + parsed.Host
	}
	return settings{url: raw + endpoint, origin: origin, token: token}, true
}

// A request Heddohon answered with something other than 200.
type refused struct{ status int32 }

func (r refused) Error() string { return fmt.Sprintf("Heddohon answered %d", r.status) }

// Posts one message. The error is a `refused` when Heddohon answered, and the
// network's own otherwise.
func send(cfg settings, msg message) (answer, error) {
	msg.V = protocol
	body, err := json.Marshal(msg)
	if err != nil {
		return answer{}, err
	}
	response, err := host.HTTPSend(host.HTTPRequest{
		Method: "POST",
		URL:    cfg.url,
		Headers: map[string]string{
			"Authorization": "Bearer " + cfg.token,
			"Content-Type":  "application/json",
			// Heddohon refuses a write whose Origin is not its own address,
			// which is what keeps another site's page from writing to it.
			"Origin": cfg.origin,
		},
		Body:      body,
		TimeoutMs: int32(requestTimeout / time.Millisecond),
		// The token goes only to the address configured.
		NoFollowRedirects: true,
	})
	if err != nil {
		return answer{}, err
	}
	if response.StatusCode != 200 {
		return answer{}, refused{response.StatusCode}
	}
	var out answer
	if err := json.Unmarshal(response.Body, &out); err != nil {
		return answer{}, err
	}
	return out, nil
}

type heddohon struct{}

func init() {
	lifecycle.Register(&heddohon{})
	scheduler.Register(&heddohon{})
	scrobbler.Register(&heddohon{})
}

func main() {}

var (
	_ lifecycle.InitProvider     = (*heddohon)(nil)
	_ scheduler.CallbackProvider = (*heddohon)(nil)
	_ scrobbler.Scrobbler        = (*heddohon)(nil)
)

func (*heddohon) OnInit() error {
	// Refused when the schedule is already there, which is what is wanted.
	if _, err := host.SchedulerScheduleRecurring(pollEvery, "", pollSchedule); err != nil {
		pdk.Log(pdk.LogDebug, "heddohon: poll not scheduled: "+err.Error())
	}
	if _, ok := configured(); !ok {
		pdk.Log(pdk.LogWarn, "heddohon: set the Heddohon address and the plugin token in this plugin's settings")
	}
	return nil
}

// Every user assigned to the plugin, once it is configured. Heddohon drops the
// plays of a user it has no account for.
func (*heddohon) IsAuthorized(scrobbler.IsAuthorizedRequest) (bool, error) {
	_, ok := configured()
	return ok, nil
}

// The name Heddohon gives Navidrome as a client. Its browsers tell it what
// they play themselves, so its own reports are not sent back to it.
const ownClient = "heddohon"

// Not sent: Navidrome reports the same event through PlaybackReport, with
// the client it came from.
func (*heddohon) NowPlaying(scrobbler.NowPlayingRequest) error { return nil }

// What a client is playing now. Navidrome sends it for every client, as a
// track starts and whenever the client says where it is, and does not send it
// again when it fails, so a Heddohon that is down misses it and nothing is
// returned for Navidrome to log.
func (*heddohon) PlaybackReport(request scrobbler.PlaybackReportRequest) error {
	cfg, ok := configured()
	if !ok || strings.EqualFold(request.PlayerName, ownClient) || request.PlayerId == "" {
		return nil
	}
	if _, err := send(cfg, message{
		Type:       "playback",
		Username:   request.Username,
		SongID:     request.Track.ID,
		State:      request.State,
		PositionMs: request.PositionMs,
		Player:     request.PlayerId,
		PlayerName: request.PlayerName,
	}); err != nil {
		pdk.Log(pdk.LogDebug, "heddohon: playback not sent: "+err.Error())
	}
	return nil
}

func (*heddohon) Scrobble(request scrobbler.ScrobbleRequest) error {
	cfg, ok := configured()
	if !ok {
		return scrobbler.ScrobblerErrorNotAuthorized
	}
	_, err := send(cfg, message{
		Type:  "plays",
		Plays: []play{{Username: request.Username, SongID: request.Track.ID, At: request.Timestamp}},
	})
	if err == nil {
		return nil
	}
	// Navidrome keeps a play it is told to retry and sends it again later, in
	// order. A play Heddohon will never take (a 400) is given up, so it does
	// not hold back the ones behind it. Everything else is a server that is
	// down or a setting that is wrong, and the play waits for it.
	if answered, ok := err.(refused); ok && answered.status >= 400 && answered.status < 500 &&
		answered.status != 401 && answered.status != 403 && answered.status != 404 && answered.status != 429 {
		pdk.Log(pdk.LogWarn, "heddohon: play not taken: "+err.Error())
		return scrobbler.ScrobblerErrorUnrecoverable
	}
	pdk.Log(pdk.LogWarn, "heddohon: play kept for later: "+err.Error())
	return scrobbler.ScrobblerErrorRetryLater
}

// The poll. Heddohon answers with the accounts whose history it is waiting
// for, and each page sent is answered with the same list brought up to date.
func (*heddohon) OnCallback(scheduler.SchedulerCallbackRequest) error {
	cfg, ok := configured()
	if !ok {
		return nil
	}
	started := time.Now()
	reply, err := send(cfg, message{Type: "poll"})
	for err == nil && len(reply.Wanted) > 0 && time.Since(started) < callBudget {
		next := reply.Wanted[0]
		from := next.From
		page, more, readErr := host.ScrobbleRetrieverGetScrobbles(next.Username, host.ScrobbleOptions{
			FromTimestamp: &from,
			MaxItems:      historyPage,
		})
		if readErr != nil {
			// The user is not assigned to the plugin. Heddohon is told, so the
			// account is not left waiting.
			pdk.Log(pdk.LogWarn, "heddohon: history of "+next.Username+" not read: "+readErr.Error())
			reply, err = send(cfg, message{Type: "history", Username: next.Username, Failed: true})
			continue
		}
		plays := make([]play, len(page))
		for i, scrobble := range page {
			plays[i] = play{SongID: scrobble.MediaFileID, At: scrobble.SubmissionTime}
		}
		reply, err = send(cfg, message{Type: "history", Username: next.Username, Plays: plays, More: more != nil})
	}
	if err != nil {
		// Every 15 seconds while Heddohon is down, so not at a level shown by default.
		pdk.Log(pdk.LogDebug, "heddohon: "+err.Error())
	}
	return nil
}
