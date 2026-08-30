function Game(canvas) 
{
	this.KEY_W = 87;
	this.KEY_A = 65;
	this.KEY_S = 83;
	this.KEY_D = 68;

	this.KEY_Up = 38;
	this.KEY_Left = 37;
	this.KEY_Down = 40;
	this.KEY_Right = 39;

	// Constants
	this.transfer_rate_k = 0.25;

	// Variables and setup
    this.bg_temp;
	this.phys;
	this.wall;
	this.player;
	this.keys = [];
	this.canvas = canvas;
	this.ctx = this.canvas.getContext('2d');
	this.cam = new Camera(canvas);
	this._lastTick = (new Date()).getTime();	// for timer
	this.frameSpacing;							// for timer
	this.frame_delta;							// for timer
    this.frame_delta_smoothed = 0;
	this.bg_color = "#BAD4ED";		// Background color of the level (inside the boundaries)
	this.level_width = 800;		// Just a default; Will be set in load_level
	this.level_height = 800;	// Just a default; Will be set in load_level
	this.won = false;			// Indicates if the player has won (and is now just basking in his own glory)
	this.paused = false;
	this.has_started = false;	// Indicates if the intro menu has been dismissed at least once
	this.debug = false;
	this.shadows = true;
    this.debugInfo;
	this.music = new MusicPlayer(
		[	// Music tracks (filename, song name, artist)
			['duncan beattie - sevenhundredbeats.mp3', 'sevenhundredbeats', 'duncan beattie'],
		], 
		{	// Sound effects (identifier, filename)
			'blip': ['blip.ogg'],
			'win': ['win.ogg'],
			'death': ['death.ogg'],
			'bounce': ['bounce.ogg'],
			'bark': ['4910__NoiseCollector__barkdouble.wav'],
			'm4a1': ['89006__metamorphmuses__hack.wav'],
		}
	);

	// Methods
	this.init = function() 
    {
		// Event registration
        this.canvas.addEventListener('mousemove', this.mouse_move, false);
		this.canvas.addEventListener('mousedown', this.mouse_down, false);
        this.canvas.addEventListener('mouseup', this.mouse_up, false);
		this.canvas.addEventListener('touchstart', this.touch_start, false);
		if(window.addEventListener) 
        {
			document.addEventListener('DOMMouseScroll', this.mouse_scroll, false);
			document.addEventListener('mousewheel', this.mouse_scroll, false);
			window.addEventListener("keydown", this.key_down, false);
			window.addEventListener("keyup", this.key_up, false);
			window.addEventListener("blur", function() {game.pause(true);}, false);
			
			document.getElementById("mute").addEventListener('click', function() {game.music.mute();}, false);
			document.getElementById("newlevel").addEventListener('click', function() {game.load_level();}, false);
			document.getElementById("pause").addEventListener('click', function() {game.pause();}, false);
			document.getElementById("help").addEventListener('click', function() {game.toggle_help();}, false);
			document.getElementById("pausedmessage").addEventListener('click', function() {game.pause();}, false);
			document.getElementById("deathmessage").addEventListener('click', function() {game.load_level();}, false);
			document.getElementById("warningmessage").addEventListener('click', function() {game.load_level();}, false);
			document.getElementById("successmessage").addEventListener('click', function() {game.load_level();}, false);

            this.debugInfo = document.getElementById('debuginfo');
			
			//document.getElementById("playbutton").addEventListener('click', function() {game.toggle_help();}, false);
		}
		
		this.music.init();
	};

	this.toggle_help = function() 
    {
		var overlay = document.getElementById("helpoverlay");
		
		// If overlay is hidden
		if (overlay.style.display == "none") {
			this.pause(true);					// Pause the game
			overlay.style.display = "block";	// Show overlay
		}
		else 
        {
			overlay.style.display = "none";		// Hide overlay
		}
		
		// If we're just now starting the game
		if (!this.has_started) {
			//this.load_level();
			this.music.play_song();
			this.has_started = true;
		}
	};
	this.pause = function(forcepause) 
    {
		if (this.paused && !forcepause) 
        {
			// Unpause
			this.clear_msgs();
			this.paused = false;
			this.music.raise_volume();
		}
		else 
        {
			// Pause
			this.show_message("pausedmessage");
			this.paused = true;
			this.music.lower_volume();
		}
	};

	this.load_level = function() 
	{
        this.bg_temp = new PixelSprite("content/sprites/bg_temp.png");

		var posX = 150;
		var posY = 200;

		this.phys = new SpringPhysics();
		this.wall = new Wall(posX, posY);
		this.player = new Player(this.phys, this.wall, posX, posY);

		this.won = false;
		this.clear_msgs();
		
		// Define level boundary
		this.level_radius = 500;
		
		this.keys = [];
		for (var k = 0; k < 255; k++) 
		{
			this.keys.push(false);
		}

		// Center camera over level
		if (this.cam.x == 0 && this.cam.y == 0) {
			this.cam.x = this.level_width / 2;
			this.cam.y = this.level_width / 2;
		}
		this.cam.x_target = this.cam.x;
		this.cam.y_target = this.cam.y;

	};

	this.ResetPhysics = function()
	{
		var n;
		for ( n = 0; n < this.phys.particleStates.length; n++ )
		{
			var state = this.phys.particleStates[n];

			state.velX = 0;
			state.velY = 0;
		}
	}

	this.LetGo = function()
	{
		this.player.LetGo();
	}

	

    this.click_at_point = function(x, y) 
    {
		if (!game.paused) 
        {
			// Convert view coordinates (clicked) to world coordinates
			x = this.cam.viewport_to_world_x(x);
			y = this.cam.viewport_to_world_y(y);

			/*if( this.dog.entity.IsInside(x, y) )
			{
				// TODO: activate dog
				this.music.play_sound("bark");
			}
			else
			{
                if(this.player.state & CREATURE_STATE_AIMING )
                {
				    this.music.play_sound("m4a1");
				    this.SpawnBullet(x, y);
                }
			}*/
		}
	};
	this.touch_start = function(ev) 
    {
		ev.preventDefault();		// Prevent dragging
		var touch = ev.touches[0];	// Just pay attention to first touch
		
		game.click_at_point(touch.pageX, touch.pageY);
	};

    var MOUSE_BUTTON_LEFT = 0;
    var MOUSE_BUTTON_RIGHT = 2;

    this.mouse_move = function(ev) 
    {
		ev.preventDefault();
		if (ev.layerX || ev.layerX == 0) { // Firefox
			ev._x = ev.layerX;
			ev._y = ev.layerY;
		} else if (ev.offsetX || ev.offsetX == 0) { // Opera
			ev._x = ev.offsetX;
			ev._y = ev.offsetY;
		}
        ev._x = game.cam.viewport_to_world_x(ev._x);
		ev._y = game.cam.viewport_to_world_y(ev._y);
		//game.SetAimTarget(ev._x, ev._y);
	};
	this.mouse_down = function(ev) 
    {
		ev.preventDefault();
		if (ev.layerX || ev.layerX == 0) { // Firefox
			ev._x = ev.layerX;
			ev._y = ev.layerY;
		} else if (ev.offsetX || ev.offsetX == 0) { // Opera
			ev._x = ev.offsetX;
			ev._y = ev.offsetY;
		}
        if( ev.button == MOUSE_BUTTON_LEFT )
        {
            game.click_at_point(ev._x, ev._y);
        }
        else if (ev.button == MOUSE_BUTTON_RIGHT)
        {
            //game.player.state = CREATURE_STATE_AIMING;
        }
	};
    this.mouse_up = function(ev) 
    {
		ev.preventDefault();
		if (ev.layerX || ev.layerX == 0) 
        { // Firefox
			ev._x = ev.layerX;
			ev._y = ev.layerY;
		} else if (ev.offsetX || ev.offsetX == 0) 
        { // Opera
			ev._x = ev.offsetX;
			ev._y = ev.offsetY;
		}
        if (ev.button == MOUSE_BUTTON_RIGHT)
        {
            //game.player.state = CREATURE_STATE_NORMAL;
        }
	};
	this.mouse_scroll = function(event) 
    {
		var delta = 0;
 
		if (!event) event = window.event;

		// normalize the delta
		if (event.wheelDelta) {
			// IE and Opera
			delta = event.wheelDelta / 60;
		} else if (event.detail) {
			// W3C
			delta = -event.detail / 2;
		}
		delta = delta / Math.abs(delta);
		
		if (delta != 0) {
			if (delta > 0)
				game.cam.scale_target *= 1.2;
			if (delta < 0)
				game.cam.scale_target /= 1.2;
		}
	};

	this.key_up = function(e) 
	{
		var code;
		if (!e)	var e = window.event;
		if (e.keyCode) code = e.keyCode;
		else if (e.which) code = e.which;

		game.keys[code] = false;
	}

	this.key_down = function(e) 
	{
		var code;
		if (!e)	var e = window.event;
		if (e.keyCode) code = e.keyCode;
		else if (e.which) code = e.which;
		
		game.keys[code] = true;
		
		switch (code)
		{ 
			case 80:	// P
				game.pause();
				break;
			case 82:	// R
				game.load_level();
				break;
			case 68:	// D
				game.debug = !game.debug;
				break;
			case 70:	// F
				game.LetGo();
				break;
			case 72:	// H
				game.toggle_help();
				break;
			case 83:	// S
				game.ResetPhysics();
				break;
			case 77:	// M
				game.music.mute();
				break;
			case 78:	// N
				game.music.next_song();
				break;
		}
	};
	this.clear_msgs = function(forceclear) 
    {
		var msgs = document.getElementsByClassName("messages");
		for (var i=0; i<msgs.length; i++)
			msgs[i].style.display = "none";
		
		// Re-show important messages that are still relevant
		if (!forceclear) {
			if (this.won)
				this.show_message("successmessage");
			else if (this.player && this.player.IsDead)
				this.show_message("deathmessage");
		}
	};
	this.show_message = function(id) {
		this.clear_msgs(true);
		var div = document.getElementById(id);
		if (div) {
			div.style.display = "block";
		}
	};
	this.player_did_die = function() 
    {
		this.music.play_sound("death");
		this.show_message("deathmessage");
	};
	this.player_did_win = function() 
    {
		if (!this.won) 
        {
			this.won = true;
			this.music.play_sound("win");
			this.show_message("successmessage");
		}
	};

	this.update = function() 
	{
		/*if (!this.has_started) 
		{
			game.toggle_help();
		}*/

		// Advance timer
		var currentTick = (new Date()).getTime();
		this.frameSpacing = currentTick - this._lastTick;
		this.frame_delta = this.frameSpacing * 0.001;       // convert ms to s
		this._lastTick = currentTick;

        this.frame_delta = Math.min(0.1, this.frame_delta); // minimum 10 Hertz

        this.frame_delta_smoothed = this.frame_delta_smoothed * 0.7 + this.frame_delta * 0.3;
        this.frame_delta = this.frame_delta_smoothed;   // smooth real delta to have smoother movements

		// Canvas maintenance
		//this.canvas.height = window.innerHeight;
		//this.canvas.width = window.innerWidth;
		//center = [this.canvas.width/2, this.canvas.height/2];

        this.ctx.fillStyle = this.bg_color;
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.beginPath();
		this.ctx.rect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.closePath();
		this.ctx.fill();

		this.HandleInput( this.frame_delta_smoothed );
		
		// TODO: Camera tracks player
		this.cam.update(140, 210, this.frame_delta);

        if( !this.paused )
        {	//	update world

			this.wall.Update( this.frame_delta );
			this.phys.Update( this.frame_delta );

			this.player.Update( this.frame_delta );
        }

		// rendering
		{
            // render World

			this.wall.Draw(this.ctx, this.cam);

            //this.bg_temp.Draw(this.ctx, this.cam, 0, 0);
			this.player.Draw(this.ctx, this.cam);
		}

		// Update music player
		this.music.update();

        var debugInfo = 'FPS: ' + (1.0 / this.frame_delta_smoothed).toFixed(2);

        SetTextOfElement( this.debugInfo, debugInfo );
	};

	this.HandleInput = function( deltaTime ) 
	{
		var bowStrength = 2.0;

		/*if( this.keys[this.KEY_W] || this.keys[this.KEY_Up] )
		{
			this.player.entity.velY -= playerSpeed;
		}
		if( this.keys[this.KEY_S] || this.keys[this.KEY_Down] )
		{
			this.player.entity.velY += playerSpeed;
		}*/
		if( this.keys[this.KEY_A] || this.keys[this.KEY_Left] )
		{
			this.player.AddBowOffset(bowStrength * deltaTime);
		}
		if( this.keys[this.KEY_D] || this.keys[this.KEY_Right] )
		{
			this.player.AddBowOffset(-bowStrength * deltaTime);
		}
	}

	// Call init
	this.init();
}

function SetTextOfElement(element, text)
{
	if(element.firstChild)
	{
		element.firstChild.nodeValue = text;
	}
	else
	{
		element.appendChild( document.createTextNode(text) );
	}
}

function Point(x, y)
{
    this.x = x;
    this.y = y;
}