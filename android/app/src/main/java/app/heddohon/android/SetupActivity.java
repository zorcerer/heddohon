package app.heddohon.android;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The address screen: on a first run, and from the icon's Change server
 * shortcut. The address is saved only once a Heddohon has answered at it.
 */
public class SetupActivity extends Activity {
	private final ExecutorService background = Executors.newSingleThreadExecutor();
	private final Handler main = new Handler(Looper.getMainLooper());
	private EditText address;
	private TextView problem;
	private Button connect;
	/** An address a proxy asked for a sign-in at, offered to be opened as it stands. Pressing the button again opens it. */
	private String behindSignIn;

	@Override
	protected void onCreate(Bundle state) {
		super.onCreate(state);
		setContentView(R.layout.setup);
		address = findViewById(R.id.address);
		problem = findViewById(R.id.problem);
		connect = findViewById(R.id.connect);

		String saved = Server.saved(this);
		if (saved != null && state == null) address.setText(saved);

		connect.setOnClickListener((view) -> submit());
		// A changed address is checked afresh: the offer to open the last one as it stands is withdrawn.
		address.addTextChangedListener(new android.text.TextWatcher() {
			@Override
			public void beforeTextChanged(CharSequence text, int start, int count, int after) {}

			@Override
			public void onTextChanged(CharSequence text, int start, int before, int count) {}

			@Override
			public void afterTextChanged(android.text.Editable text) {
				if (behindSignIn == null) return;
				behindSignIn = null;
				connect.setText(R.string.setup_connect);
			}
		});
		address.setOnEditorActionListener((view, action, event) -> {
			if (action != EditorInfo.IME_ACTION_GO) return false;
			submit();
			return true;
		});
	}

	private void submit() {
		Address typed = Address.parse(address.getText().toString());
		if (typed.problem != null) {
			say(getString(typed.problem == Address.Problem.NEEDS_HTTPS ? R.string.setup_needs_https : R.string.setup_not_address));
			return;
		}
		String origin = typed.origin;
		// The second press, on the same address: opened as it is, and signed in to in the browser.
		if (origin.equals(behindSignIn)) {
			open(origin);
			return;
		}
		behindSignIn = null;
		say(null);
		busy(true);
		background.execute(() -> {
			Server.Answer answer = Server.check(origin);
			main.post(() -> {
				if (isFinishing() || isDestroyed()) return;
				busy(false);
				if (answer == Server.Answer.HEDDOHON) {
					open(origin);
				} else if (answer == Server.Answer.SIGN_IN) {
					behindSignIn = origin;
					say(getString(R.string.setup_sign_in, origin));
					connect.setText(R.string.setup_open_anyway);
				} else {
					say(getString(answer == Server.Answer.UNREACHABLE ? R.string.setup_unreachable : R.string.setup_not_heddohon, origin));
				}
			});
		});
	}

	private void open(String origin) {
		Server.save(this, origin);
		startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
		finish();
	}

	private void busy(boolean checking) {
		connect.setEnabled(!checking);
		connect.setText(checking ? R.string.setup_checking : R.string.setup_connect);
	}

	private void say(String message) {
		problem.setText(message == null ? "" : message);
		problem.setVisibility(message == null ? View.GONE : View.VISIBLE);
	}

	@Override
	protected void onDestroy() {
		super.onDestroy();
		background.shutdownNow();
	}
}
