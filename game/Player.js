

function Player_Update( deltaTime )
{
	this.rope.Update( deltaTime );
	this.skeleton.Update( deltaTime );
	this.climbingAI.Update( deltaTime );
}

function Player_Draw( ctx, cam )
{
	this.rope.Draw( ctx, cam );
	this.skeleton.Draw( ctx, cam );
	this.climbingAI.Draw( ctx, cam );
}

function Player_AddBowOffset( offset )
{
	this.skeleton.AddBowOffset( offset );
}


function Player( phys, wall, posX, posY )
{
	this.rope;
	this.skeleton;
	this.climbingAI;

	// methods
	this.Update = Player_Update;
	this.Draw = Player_Draw;

	this.AddBowOffset = Player_AddBowOffset;

	this.LetGo = function()
	{
		this.skeleton.LetGo();
	}

	this.Initialize = function ( phys, wall, posX, posY )
	{
		this.skeleton = new Skeleton( phys, wall, posX, posY );
		this.rope = new Rope( phys, wall, this.skeleton, posX, posY );
		this.climbingAI = new ClimbingAI( this.rope, wall, this.skeleton );
	}

	this.Initialize( phys, wall, posX, posY );
}
