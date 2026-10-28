import { createComponent, createWorld } from "./core";

const Player = createComponent("Player");

const world = createWorld();

for (const chunk of world.query(Player)) {
    
}
