---
title: "Elixir & Phoenix with the X API v2: An OAuth 2.0 Refresh"
description: "An updated take on my original Elixir + Twitter OAuth tutorial, rebuilt for Phoenix's current conventions and X's OAuth 2.0 + PKCE flow now that the old API v1.1 / OAuth 1.0a approach is effectively retired."
publishedAt: 2026-09-09
tags: ["elixir", "phoenix", "oauth2", "x-api", "pkce"]
---

Back in 2021 I wrote [Intro to Elixir and Phoenix using Twitter OAuth](/blog/intro-to-elixir-using-phoenix-and-twitter-oauth) using `ExTwitter`, OAuth 1.0a, and API v1.1. Almost none of that still applies:

- Twitter is now **X**, and most of the API surface moved to **API v2**.
- OAuth 1.0a has been replaced by **OAuth 2.0 Authorization Code with PKCE** for user-context actions like posting.
- `ExTwitter` hasn't been meaningfully updated in years and doesn't speak API v2 or OAuth 2.0 at all.
- Phoenix has moved away from `Phoenix.View` and `.eex` templates in favor of **HEEx** function components and **verified routes** (the `~p` sigil).
- Read access on the free API tier is now extremely limited — expect to mostly be posting, not reading, unless you pay for a higher tier.

This is the same project, rebuilt with what's current. I'm keeping the same scope as before on purpose:

- Authenticate, sign in with X, and sign out
- Post to your timeline
- List your most recent posts

## What this tutorial will not have

- LiveView (Phoenix scaffolds it by default now — we just won't use it)
- Ecto-backed persistence — tokens still live in the session, not a database
- Custom email/password auth (if you want that, `mix phx.gen.auth` is the official generator these days and can live alongside this)

## What this tutorial does have

- OAuth 2.0 Authorization Code flow with **PKCE**, implemented directly with [`Req`](https://hexdocs.pm/req) instead of a Twitter-specific hex package
- X API **v2** endpoints (`/2/oauth2/token`, `/2/users/me`, `/2/tweets`, `/2/users/:id/tweets`)
- A small `App.X` context module instead of scattering HTTP calls through controllers
- Current Phoenix conventions: verified routes, HEEx templates, `embed_templates`

### X Developer Portal

1. Apply for a developer account at [developer.x.com](https://developer.x.com) (this used to live at `developer.twitter.com` — you may still get redirected from there).
2. Create a **Project**, then an **App** inside it. API v2 access requires the project structure now; standalone apps from the old v1.1 days aren't an option for new accounts.
3. In the app's **User authentication settings**, turn on **OAuth 2.0**:
   - App type: *Web App, Automated App or Bot*
   - Callback / redirect URL: `http://localhost:4000/auth/callback`
   - Website URL: anything, e.g. `http://localhost:4000`
4. Save it, and X will show you a **Client ID** and **Client Secret**. You'll only see the secret once — copy it now.
5. Check which **access tier** your project is on before you start. As of this writing, the free tier gives you write access (posting) but essentially no read access to endpoints like a user's timeline — that requires a paid tier. Tiers and pricing change often enough that it's worth confirming in the portal rather than trusting a number in this post.

### How to install Erlang and Elixir

I still recommend a version manager over installing Elixir globally. `asdf` remains a solid choice; [`mise`](https://mise.jdx.dev) is a newer alternative a lot of the Elixir community has moved to if you want something faster with less shell config.

1. [Install Elixir and Erlang with asdf](https://elixir-lang.org/install.html#asdf)
2. [Other installation options](https://elixir-lang.org/install.html)

Grab whatever the current stable Elixir release is (`asdf list all elixir` or `mise ls-remote elixir`) — it'll want a reasonably recent Erlang/OTP alongside it, which asdf/mise will resolve for you.

### Create a new project

1. Install the Phoenix project generator if you haven't already:

   ```bash
   mix archive.install hex phx_new
   ```

2. `mix phx.new appname` — say *yes* to fetching dependencies. Phoenix generates a LiveView-ready app and an Ecto setup by default now; we're not using either, but there's no harm leaving them in.
3. `cd appname`
4. `mix ecto.create` — still needed just to let the server boot, same as before.
5. `mix phx.server` (`CTRL+C` twice to stop it)

6. Add `Req` to `mix.exs`. It's become the default choice for HTTP calls in Elixir — built on `Finch`, no separate JSON library or connection pool setup required:

   ```elixir
   defp deps do
     [
       # ...
       {:req, "~> 0.5"}
     ]
   end
   ```

   Run `mix deps.get` afterward.

7. Add your credentials to `.env` in the project root, and `source .env` before running the server:

   ```bash
   export X_CLIENT_ID="YOUR CLIENT ID HERE"
   export X_CLIENT_SECRET="YOUR CLIENT SECRET HERE"
   ```

8. Read those into config, e.g. in `config/dev.exs`:

   ```elixir
   config :app,
     x_client_id: System.get_env("X_CLIENT_ID"),
     x_client_secret: System.get_env("X_CLIENT_SECRET")
   ```

### The `App.X` context

Instead of spreading OAuth and API calls across controllers like the old `ExTwitter.configure/2` approach did, this all lives in one context module. It covers building the authorize URL, generating a PKCE pair, exchanging a code for tokens, and the three API calls we need.

<details>
  <summary>lib/app/x.ex</summary>

```elixir
defmodule App.X do
  @moduledoc """
  Minimal client for the X API v2, authenticated via
  OAuth 2.0 Authorization Code + PKCE.
  """

  @auth_host "https://x.com"
  @api_host "https://api.x.com"

  def new_pkce_pair do
    verifier = :crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false)
    challenge = :crypto.hash(:sha256, verifier) |> Base.url_encode64(padding: false)
    {verifier, challenge}
  end

  def authorize_url(redirect_uri, state, code_challenge) do
    query =
      URI.encode_query(%{
        response_type: "code",
        client_id: client_id(),
        redirect_uri: redirect_uri,
        scope: "tweet.read tweet.write users.read offline.access",
        state: state,
        code_challenge: code_challenge,
        code_challenge_method: "S256"
      })

    "#{@auth_host}/i/oauth2/authorize?#{query}"
  end

  def exchange_code(code, redirect_uri, code_verifier) do
    post_token(%{
      grant_type: "authorization_code",
      code: code,
      redirect_uri: redirect_uri,
      code_verifier: code_verifier
    })
  end

  def refresh_token(refresh_token) do
    post_token(%{grant_type: "refresh_token", refresh_token: refresh_token})
  end

  defp post_token(params) do
    req()
    |> Req.post(
      url: "/2/oauth2/token",
      form: Map.put(params, :client_id, client_id()),
      auth: {:basic, "#{client_id()}:#{client_secret()}"}
    )
    |> handle_response()
  end

  def me(access_token) do
    req()
    |> Req.get(url: "/2/users/me", auth: {:bearer, access_token})
    |> handle_response()
  end

  def create_tweet(access_token, text) do
    req()
    |> Req.post(url: "/2/tweets", json: %{text: text}, auth: {:bearer, access_token})
    |> handle_response()
  end

  def user_tweets(access_token, user_id, opts \\ []) do
    max_results = Keyword.get(opts, :max_results, 5)

    req()
    |> Req.get(
      url: "/2/users/#{user_id}/tweets",
      params: [max_results: max_results, "tweet.fields": "created_at"],
      auth: {:bearer, access_token}
    )
    |> handle_response()
  end

  defp handle_response({:ok, %{status: status, body: body}}) when status in 200..299,
    do: {:ok, body}

  defp handle_response({:ok, %{status: status, body: body}}), do: {:error, {status, body}}
  defp handle_response({:error, reason}), do: {:error, reason}

  defp req, do: Req.new(base_url: @api_host)

  defp client_id, do: Application.fetch_env!(:app, :x_client_id)
  defp client_secret, do: Application.fetch_env!(:app, :x_client_secret)
end
```

`Req` handles JSON encoding/decoding on its own, so `body` above is already a decoded map — no separate `Jason.decode!/1` step like you'd have needed with `HTTPoison`.

</details>

### Plugs

Same role as before: small modules that read the connection, do one thing, and pass it along the browser pipeline. We need fewer of them now since `App.X` isn't holding process-level configuration the way `ExTwitter.configure/2` did — each request just carries its own access token explicitly.

<details>
  <summary>AssignCurrentUser</summary>

```elixir
defmodule AppWeb.Plugs.AssignCurrentUser do
  import Plug.Conn

  def init(opts), do: opts

  def call(conn, _opts) do
    assign(conn, :current_user, get_session(conn, :current_user))
  end
end
```

</details>

<details>
  <summary>RequireUser</summary>

Used only in `TweetController`, same as the original — no point gating the whole app behind auth for a demo.

```elixir
defmodule AppWeb.Plugs.RequireUser do
  import Plug.Conn

  def init(opts), do: opts

  def call(conn, _opts) do
    if conn.assigns.current_user do
      conn
    else
      conn
      |> send_resp(401, "")
      |> halt()
    end
  end
end
```

</details>

### Router

Verified routes (`~p"/..."`) replace the old `Router.Helpers.page_path(conn, :index)` style — they're checked at compile time, so a typo'd path is now a compile error instead of a runtime 404.

<details>
  <summary>router.ex</summary>

```elixir
defmodule AppWeb.Router do
  use AppWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_flash
    plug :protect_from_forgery
    plug :put_secure_browser_headers
    plug AppWeb.Plugs.AssignCurrentUser
  end

  scope "/", AppWeb do
    pipe_through :browser

    get "/", PageController, :index
    get "/auth/request", AuthController, :request
    get "/auth/callback", AuthController, :callback
    get "/auth/logout", AuthController, :logout

    resources "/tweets", TweetController, only: [:create]
  end
end
```

`mix phx.routes` still works the same way to double check what got wired up.

</details>

### Controllers

<details>
  <summary>AuthController</summary>

`request/2` builds a PKCE pair, stashes the verifier and a random `state` value in the session, and sends the user to X's authorize screen. `callback/2` checks `state` matches (this is what stops a forged callback from hijacking a session), swaps the code for tokens, and fetches the user's profile to store in the session.

```elixir
defmodule AppWeb.AuthController do
  use AppWeb, :controller

  def request(conn, _params) do
    {verifier, challenge} = App.X.new_pkce_pair()
    state = Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)
    authorize_url = App.X.authorize_url(url(~p"/auth/callback"), state, challenge)

    conn
    |> put_session(:code_verifier, verifier)
    |> put_session(:oauth_state, state)
    |> redirect(external: authorize_url)
  end

  def callback(conn, %{"state" => state, "code" => code}) do
    if state == get_session(conn, :oauth_state) do
      verifier = get_session(conn, :code_verifier)

      with {:ok, token} <- App.X.exchange_code(code, url(~p"/auth/callback"), verifier),
           {:ok, %{"data" => user}} <- App.X.me(token["access_token"]) do
        conn
        |> put_session(:current_user, %{
          id: user["id"],
          username: user["username"],
          name: user["name"]
        })
        |> put_session(:access_token, token["access_token"])
        |> put_session(:refresh_token, token["refresh_token"])
        |> redirect(to: ~p"/")
      else
        _ ->
          conn
          |> put_flash(:error, "Something went wrong authenticating with X.")
          |> redirect(to: ~p"/")
      end
    else
      conn
      |> put_flash(:error, "Invalid OAuth state, please try again.")
      |> redirect(to: ~p"/")
    end
  end

  def callback(conn, %{"error" => _}) do
    conn
    |> put_flash(:error, "You did not authorize the app.")
    |> redirect(to: ~p"/")
  end

  def logout(conn, _params) do
    conn
    |> configure_session(drop: true)
    |> redirect(to: ~p"/")
  end
end
```

The two `callback/2` clauses are the same pattern-matching trick from the original tutorial — one for a successful grant, one for when the user declines. It's still one of my favorite things about Elixir.

</details>

<details>
  <summary>PageController</summary>

```elixir
defmodule AppWeb.PageController do
  use AppWeb, :controller

  def index(conn, _params) do
    case conn.assigns.current_user do
      nil ->
        render(conn, :logged_out)

      user ->
        access_token = get_session(conn, :access_token)
        {:ok, %{"data" => tweets}} = App.X.user_tweets(access_token, user.id, max_results: 5)
        render(conn, :logged_in, tweets: tweets)
    end
  end
end
```

Remember: reading `user_tweets/3` back successfully depends on your project's access tier. If you're on the free tier, expect this call to fail — that's X, not a bug in the code above. Pattern-match on `{:error, _}` here too if you want the page to degrade gracefully instead of crashing.

</details>

<details>
  <summary>TweetController</summary>

```elixir
defmodule AppWeb.TweetController do
  use AppWeb, :controller

  plug AppWeb.Plugs.RequireUser

  def create(conn, %{"message" => message}) do
    access_token = get_session(conn, :access_token)

    case App.X.create_tweet(access_token, message) do
      {:ok, %{"data" => %{"id" => id}}} ->
        user = conn.assigns.current_user
        url = "https://x.com/#{user.username}/status/#{id}"

        conn
        |> put_flash(:info, "Posted! See #{url}")
        |> redirect(to: ~p"/")

      {:error, _reason} ->
        conn
        |> put_flash(:error, "Something went wrong posting that.")
        |> redirect(to: ~p"/")
    end
  end
end
```

</details>

### HTML modules and templates

Phoenix 1.7 dropped `Phoenix.View` in favor of an `*_html.ex` module per controller that embeds `.html.heex` templates directly. No separate `AuthView`/`TweetView` modules are needed anymore — a controller only needs one if it renders a template, which ours here don't (they just redirect).

<details>
  <summary>PageHTML</summary>

```elixir
defmodule AppWeb.PageHTML do
  use AppWeb, :html

  embed_templates "page_html/*"
end
```

`lib/app_web/controllers/page_html/logged_out.html.heex`:

```heex
<p>
  You are not signed in.
  <.link href={~p"/auth/request"} class="btn">Sign in with X</.link>
</p>
```

`lib/app_web/controllers/page_html/logged_in.html.heex`:

```heex
<h2>
  Welcome, <strong>{@current_user.name}</strong>!
  <.link href={~p"/auth/logout"} class="btn">Log out</.link>
</h2>

<form method="post" action={~p"/tweets"}>
  <input type="hidden" name="_csrf_token" value={Phoenix.Controller.get_csrf_token()} />
  <input type="text" name="message" placeholder="Post something..." maxlength="280" />
  <button type="submit">Post</button>
</form>

<h3>@{@current_user.username}'s recent posts</h3>

<div class="tweets">
  <%= for tweet <- @tweets do %>
    <div class="tweet-card">{tweet["text"]}</div>
  <% end %>
</div>
```

Note the `{...}` interpolation instead of `<%= %>` for simple values — that's a HEEx-specific shorthand added in Phoenix 1.7 that only works inside tags and attributes; loops and other control flow still use `<%= %>` / `<% %>`.

</details>

### A note on token refresh

Access tokens from this flow expire (two hours, as of this writing). Because we asked for the `offline.access` scope, you also got a `refresh_token` back, which `App.X.refresh_token/1` already knows how to use. This tutorial doesn't wire up automatic refreshing — for a real app, that's a good next step: a plug that checks token age before each request and calls `App.X.refresh_token/1` when needed, storing the new pair back in the session.

### Resources

- The original 2021 version of this post: [Intro to Elixir and Phoenix using Twitter OAuth](/blog/intro-to-elixir-using-phoenix-and-twitter-oauth)
- [X API v2](https://docs.x.com/x-api) documentation
- [OAuth 2.0 Authorization Code Flow with PKCE](https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code) on X's developer docs
- [`Req`](https://hexdocs.pm/req) documentation
- [Phoenix](https://hexdocs.pm/phoenix) documentation, especially the guides on [routing](https://hexdocs.pm/phoenix/routing.html) and [controllers](https://hexdocs.pm/phoenix/controllers.html)
- What is [Pattern Matching](https://elixirschool.com/en/lessons/basics/functions/#pattern-matching)?

API endpoints, scopes, and access tiers are the parts most likely to drift again — if something here doesn't match what you see in the developer portal, trust the portal.
