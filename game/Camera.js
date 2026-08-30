function Camera(canvas) {
	// Constants
	this.scale_smoothness = 10.0;
	this.move_smoothness = 10.0;
	
	// Variables
	this.canvas = canvas;
	this.x = 0;
	this.y = 0;
	this.x_target = 0;
	this.y_target = 0;
	this.scale = 2;
	this.scale_target = 2;
	this.pixelScale = 2;
	
	// Methods
	this.world_to_viewport = function(n, dimension) {
		var canvas_side_length = (dimension == 'x') ? this.canvas.width : this.canvas.height;
		var offset = (dimension == 'x') ? this.x : this.y;
		return (n * this.scale) + (canvas_side_length / 2) - (offset * this.scale);
	};
	this.world_to_viewport_x = function(x) {
		return this.world_to_viewport(x, 'x');
	};
	this.world_to_viewport_y = function(y) {
		return this.world_to_viewport(y, 'y');
    };

    this.world_to_viewport_x_pixel = function (x)
    {
        return (x * this.pixelScale) + (this.canvas.width / 2) - (this.x * this.pixelScale);
    };
    this.world_to_viewport_y_pixel = function (y)
    {
        return (y * this.pixelScale) + (this.canvas.height / 2) - (this.y * this.pixelScale);
    };
	
	this.viewport_to_world = function(n, dimension) {
		var canvas_side_length = (dimension == 'x') ? this.canvas.width : this.canvas.height;
		var offset = (dimension == 'x') ? this.x : this.y;
		return (n + (offset * this.scale) - (canvas_side_length / 2)) / this.scale;
	};
	this.viewport_to_world_x = function(x) {
		return this.viewport_to_world(x, 'x');
	};
	this.viewport_to_world_y = function(y) {
		return this.viewport_to_world(y, 'y');
	};
	this.update = function (target_x, target_y, frame_delta)
	{
	    this.x_target = target_x;
	    this.y_target = target_y;

	    var minScale = 1.0;
	    var maxScale = 10.0;

	    if (this.scale_target < minScale)
	    {
	        this.scale_target = minScale;
	    }

	    if (this.scale_target > maxScale)
	    {
	        this.scale_target = maxScale;
	    }

	    // Gently move to target
	    if (this.scale != this.scale_target)
	    {
	        this.scale = Math.abs(this.scale + Math.max( 1.0, frame_delta *  this.scale_smoothness ) * (this.scale_target - this.scale));
	    }

	    if (this.scale < minScale)
	    {
	        this.scale = minScale;
	    }

	    if (this.scale > maxScale)
	    {
	        this.scale = maxScale;
	    }

	    this.pixelScale = Math.round(this.scale);

	    if (this.x != this.x_target)
	        this.x += frame_delta * (this.x_target - this.x) * this.move_smoothness;

	    if (this.y != this.y_target)
	        this.y += frame_delta * (this.y_target - this.y) * this.move_smoothness;
	};
}
